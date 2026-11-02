package io.github.twoarchiver.ytark.updater

import android.util.Log
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.util.LinkedHashMap
import java.util.concurrent.Executors

/**
 * Loopback-only reader for the lyrics captions userscript.
 *
 * The YouTube TV page's Content-Security-Policy (connect-src) admits
 * http://127.0.0.1 but not the lyrics services, and Letras pages send no CORS
 * headers. This server listens on 127.0.0.1 only and fetches nothing but:
 *  - LRCLIB lyrics search (lrclib.net/api/search, /api/get),
 *  - Letras song search (solr.sscdn.co/letras/m1/),
 *  - a Letras song page or its Portuguese/English translation page,
 *  - Google Translate's public endpoint (opt-in machine translation).
 * Every other host or path is refused. It never forwards headers, cookies or
 * bodies from the caller.
 */
object LetrasProxy {
    const val PORT = 38917
    private const val TAG = "YTArkLetras"
    private const val MAX_BODY = 3 * 1024 * 1024
    private const val MAX_REQUEST_LINE = 16384
    private const val MAX_TARGET = 8000
    private val letrasHosts = setOf("www.letras.mus.br", "letras.mus.br", "www.letras.com", "letras.com")
    private val letrasPath = Regex("^/[a-z0-9-]+/[a-z0-9-]+/(traducao\\.html|english\\.html)?$")
    /** Hosts whose fixed path may carry a query string. */
    private val queryPaths = mapOf(
        "lrclib.net" to setOf("/api/search", "/api/get"),
        "solr.sscdn.co" to setOf("/letras/m1/"),
        "translate.googleapis.com" to setOf("/translate_a/single"),
    )
    private val pool = Executors.newFixedThreadPool(3) { runnable ->
        Thread(runnable, "ytark-letras").apply { isDaemon = true }
    }
    private val cache = object : LinkedHashMap<String, String>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 24
    }
    @Volatile private var started = false

    @Synchronized
    fun start() {
        if (started) return
        started = true
        val thread = Thread({
            try {
                ServerSocket(PORT, 8, InetAddress.getByName("127.0.0.1")).use { server ->
                    while (true) {
                        val socket = server.accept()
                        pool.execute { serve(socket) }
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "Letras proxy stopped: ${error.javaClass.simpleName}")
            }
        }, "ytark-letras-accept")
        thread.isDaemon = true
        thread.start()
    }

    /** Returns the target only when it is one of the allowed lyrics endpoints. */
    fun allowedTarget(raw: String?): URL? {
        if (raw.isNullOrEmpty() || raw.length > MAX_TARGET) return null
        val url = try { URL(raw) } catch (_: Exception) { return null }
        if (url.protocol != "https" || url.port != -1 || url.ref != null || url.userInfo != null) return null
        if (url.host in letrasHosts) {
            return if (url.query == null && raw.length <= 300 && letrasPath.matches(url.path)) url else null
        }
        val paths = queryPaths[url.host] ?: return null
        return if (url.path in paths && !url.query.isNullOrEmpty()) url else null
    }

    private fun contentType(url: URL) = if (url.host in letrasHosts) "text/html" else "application/json"

    private fun serve(socket: Socket) {
        socket.use {
            try {
                socket.soTimeout = 10000
                val input = BufferedInputStream(socket.getInputStream())
                val requestLine = readLine(input) ?: return
                while (true) {
                    val header = readLine(input) ?: break
                    if (header.isEmpty()) break
                }
                val parts = requestLine.split(" ")
                if (parts.size < 2) return respond(socket.getOutputStream(), 400, "bad request")
                val method = parts[0]
                val target = parts[1]
                val output = socket.getOutputStream()
                when {
                    method == "OPTIONS" -> respond(output, 204, "")
                    method != "GET" -> respond(output, 405, "method not allowed")
                    target == "/ping" -> respond(output, 200, "ok")
                    target.startsWith("/fetch?u=") || target.startsWith("/letras?u=") -> {
                        val raw = URLDecoder.decode(target.substringAfter("?u="), "UTF-8")
                        val url = allowedTarget(raw) ?: return respond(output, 403, "not allowed")
                        val type = contentType(url)
                        val cached = synchronized(cache) { cache[url.toString()] }
                        if (cached != null) return respond(output, 200, cached, type)
                        val (status, body) = fetch(url)
                        if (status == 200) synchronized(cache) { cache[url.toString()] = body }
                        // Busy answers pass through so the caller can retry.
                        val relayed = if (status == 200 || status == 404 || status == 429 || status == 503) status else 502
                        respond(output, relayed, body, type)
                    }
                    else -> respond(output, 404, "not found")
                }
            } catch (error: Exception) {
                Log.w(TAG, "Letras request failed: ${error.javaClass.simpleName}")
            }
        }
    }

    private fun fetch(start: URL): Pair<Int, String> {
        var url = start
        repeat(4) {
            val connection = url.openConnection() as HttpURLConnection
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 8000
                connection.readTimeout = 10000
                connection.setRequestProperty("User-Agent", "YTArk-Letras/1.0 (Android TV; https://github.com/zTyuner/YTArk)")
                connection.setRequestProperty("Accept", "text/html, application/json, */*")
                connection.setRequestProperty("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8")
                val status = connection.responseCode
                if (status in 300..399) {
                    // Follow redirects only to other allowed Letras pages.
                    val next = connection.getHeaderField("Location")?.let {
                        try { URL(url, it).toString() } catch (_: Exception) { null }
                    }
                    url = allowedTarget(next) ?: return 404 to ""
                    return@repeat
                }
                if (status != 200) {
                    Log.w(TAG, "Letras returned $status for ${url.path}")
                    return status to ""
                }
                return 200 to readBody(connection.inputStream)
            } finally {
                connection.disconnect()
            }
        }
        return 508 to ""
    }

    private fun readBody(stream: InputStream): String {
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(16384)
        stream.use {
            while (true) {
                val count = it.read(chunk)
                if (count < 0) break
                buffer.write(chunk, 0, count)
                if (buffer.size() > MAX_BODY) break
            }
        }
        return buffer.toString("UTF-8")
    }

    private fun readLine(input: InputStream): String? {
        val line = StringBuilder()
        while (line.length < MAX_REQUEST_LINE) {
            val value = input.read()
            if (value < 0) return if (line.isEmpty()) null else line.toString()
            if (value == '\n'.code) return line.toString().trimEnd('\r')
            line.append(value.toChar())
        }
        return null
    }

    private fun respond(output: OutputStream, status: Int, body: String, type: String = "text/plain") {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val reason = when (status) {
            200 -> "OK"; 204 -> "No Content"; 400 -> "Bad Request"; 403 -> "Forbidden"
            404 -> "Not Found"; 405 -> "Method Not Allowed"; 429 -> "Too Many Requests"
            503 -> "Service Unavailable"; else -> "Bad Gateway"
        }
        val head = "HTTP/1.1 $status $reason\r\n" +
            "Content-Type: $type; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, OPTIONS\r\n" +
            "Access-Control-Allow-Private-Network: true\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        output.write(head.toByteArray(Charsets.US_ASCII))
        output.write(bytes)
        output.flush()
    }
}
