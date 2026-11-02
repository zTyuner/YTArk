// YTArk lyrics captions: pure parsing and matching rules.
//
// Nothing here touches the DOM or the network, so every rule is covered by
// tests/lyrics-data.test.mjs. lyricsCaptions.js owns fetching and display.
//
// Sources: LRCLIB (https://lrclib.net) provides timed lyrics; Letras.mus.br
// and letras.com provide the community translations, which are matched back
// to the timed lines because the two sites split verses differently.

export const LYRICS_MODES = ['original', 'pt', 'en', 'original+pt', 'original+en'];

export function modeLanguage(mode) {
  if (mode === 'pt' || mode === 'original+pt') return 'pt';
  if (mode === 'en' || mode === 'original+en') return 'en';
  return null;
}

export function modeShowsOriginal(mode) {
  return mode === 'original' || mode === 'original+pt' || mode === 'original+en';
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function fold(text) {
  let value = String(text || '').toLowerCase();
  if (typeof value.normalize === 'function') value = value.normalize('NFD');
  return value.replace(/[̀-ͯ]/g, '');
}

const NON_WORD = /[^0-9a-zßæøœͰ-ϿЀ-ӿ぀-ヿ㐀-鿿가-힯]+/g;

/** Lowercased letters and digits only, used to compare lines and titles. */
export function normalize(text) {
  return fold(text).replace(NON_WORD, '');
}

export function words(text) {
  return fold(text).split(NON_WORD).filter(Boolean);
}

const ENTITIES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', hellip: '…',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—',
};

export function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!code || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch (_) { return match; }
    }
    const named = ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

export function htmlText(fragment) {
  return decodeEntities(String(fragment || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Video title -> artist/track guesses
// ---------------------------------------------------------------------------

const NOISE = '(official|oficial|video|vídeo|clipe|clip|lyric|letra|legendad|tradu|audio|áudio|'
  + 'visualizer|\\bhd\\b|4k|remaster|\\blive\\b|ao vivo|en vivo|\\bmv\\b|m/v|performance|karaok)';
const NOISE_BRACKETS = new RegExp(`\\s*[\\(\\[【][^\\)\\]】]*${NOISE}[^\\)\\]】]*[\\)\\]】]`, 'gi');
const ALL_BRACKETS = /\s*[([【][^)\]】]*[)\]】]/g;

export function stripFeaturing(text) {
  return String(text || '').replace(/\s+[([]?(ft\.?|feat\.?|featuring|part\.)\s+.*$/i, '').trim();
}

export function cleanTitle(title, aggressive) {
  let result = String(title || '');
  result = result.replace(aggressive ? ALL_BRACKETS : NOISE_BRACKETS, '');
  result = result.replace(/\s*[|｜].*$/, '');
  result = result.replace(/\s#\S+/g, '');
  result = result.replace(/["“”«»]/g, '');
  return result.replace(/\s{2,}/g, ' ').trim();
}

export function cleanChannel(author) {
  return String(author || '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s*(official|oficial)(\s*(channel|canal))?$/i, '')
    .trim();
}

/**
 * Ordered {artist, track} guesses. An empty artist means a free-text search
 * whose `track` holds the whole query.
 */
export function lyricsQueries(title, author) {
  const queries = [];
  const seen = new Set();
  const add = (artist, track) => {
    const a = stripFeaturing(artist);
    const t = stripFeaturing(track);
    if (!t) return;
    const key = `${normalize(a)}|${normalize(t)}`;
    if (seen.has(key)) return;
    seen.add(key);
    queries.push({ artist: a, track: t });
  };
  const channel = cleanChannel(author);
  for (const aggressive of [false, true]) {
    const clean = cleanTitle(title, aggressive);
    if (!clean) continue;
    let artist = '';
    let track = clean;
    for (const separator of [' - ', ' – ', ' — ', ' -- ', ' ~ ']) {
      const index = clean.indexOf(separator);
      if (index > 0) {
        artist = clean.slice(0, index);
        track = clean.slice(index + separator.length);
        break;
      }
    }
    if (artist) {
      add(artist, track);
      const split = artist.search(/(,|&| e | x | and )/i);
      if (split > 0) add(artist.slice(0, split), track);
      // "Track - Artist" titles exist too.
      if (channel && normalize(track).indexOf(normalize(channel)) >= 0) add(track, artist);
    }
    if (channel) add(channel, track);
    add('', `${artist || channel} ${track}`);
  }
  return queries;
}

// ---------------------------------------------------------------------------
// LRCLIB
// ---------------------------------------------------------------------------

/** Timed lines [{t, text}] from LRC text, sorted by time. */
export function parseLrc(lrc) {
  const lines = [];
  const tag = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const times = [];
    let end = 0;
    let match;
    tag.lastIndex = 0;
    while ((match = tag.exec(raw)) !== null) {
      times.push(Number(match[1]) * 60 + Number(match[2].replace(':', '.')));
      end = tag.lastIndex;
    }
    if (!times.length) continue;
    const text = raw.slice(end).replace(/<\d{1,3}:\d{1,2}(?:\.\d{1,3})?>/g, '').trim();
    for (const t of times) lines.push({ t, text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

export function plainLines(text) {
  return String(text || '').split(/\r?\n/).map(line => ({ text: line.trim() }));
}

/** Best LRCLIB search result: timed lyrics first, then the closest duration. */
export function pickLrclibResult(results, query, duration) {
  if (!Array.isArray(results)) return null;
  const wanted = normalize(query && query.track);
  const freeText = !(query && query.artist);
  let best = null;
  let bestScore = -Infinity;
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const synced = typeof result.syncedLyrics === 'string' && result.syncedLyrics.trim();
    const plain = typeof result.plainLyrics === 'string' && result.plainLyrics.trim();
    if (!synced && !plain) continue;
    if (freeText) {
      // Free-text hits must at least name the track that was asked for.
      const name = normalize(result.trackName);
      if (name.length < 2 || wanted.indexOf(name) < 0) continue;
    }
    let score = synced ? 1000 : 0;
    if (duration > 0) {
      // An entry without a length must not outrank one that matches the video.
      score -= typeof result.duration === 'number'
        ? Math.min(Math.abs(result.duration - duration), 600) : 300;
    }
    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }
  return best;
}

/** Song record from an LRCLIB result, or null when it has no lyrics. */
export function songFromLrclib(result, query) {
  if (!result) return null;
  const synced = typeof result.syncedLyrics === 'string' && result.syncedLyrics.trim();
  const lines = synced ? parseLrc(result.syncedLyrics) : plainLines(result.plainLyrics);
  if (!lines.some(line => line.text)) return null;
  // LRCLIB names can carry album tags ("Song [Song, 2017]"); keep the cleaner
  // query names whenever the artist was known.
  const known = Boolean(query && query.artist);
  return {
    artist: known ? query.artist : (result.artistName || ''),
    track: known ? query.track : (result.trackName || (query && query.track) || ''),
    lines,
    synced: Boolean(synced),
    source: 'LRCLIB',
  };
}

// ---------------------------------------------------------------------------
// Letras.mus.br / letras.com
// ---------------------------------------------------------------------------

/** {dns, slug} of the first song in a Letras search answer that names the track. */
export function parseLetrasSearch(body, track) {
  let text = String(body || '');
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (text.trim()[0] !== '{' && open >= 0 && close > open) text = text.slice(open + 1, close);
  let root;
  try { root = JSON.parse(text); } catch (_) { return null; }
  const docs = root && root.response && root.response.docs;
  if (!Array.isArray(docs)) return null;
  const wanted = normalize(track);
  for (const doc of docs) {
    if (!doc || String(doc.t) !== '2') continue;
    const dns = typeof doc.dns === 'string' ? doc.dns : '';
    const slug = doc.url === undefined || doc.url === null ? '' : String(doc.url);
    const name = normalize(doc.txt);
    if (!/^[a-z0-9-]+$/.test(dns) || !/^[a-z0-9-]+$/.test(slug) || !name) continue;
    if (wanted.indexOf(name) < 0 && name.indexOf(wanted) < 0) continue;
    return { dns, slug };
  }
  return null;
}

export function letrasSongUrl(match) {
  return `https://www.letras.mus.br/${match.dns}/${match.slug}/`;
}

/** Portuguese lives on letras.mus.br; English on its sister site letras.com. */
export function letrasTranslationUrl(match, language) {
  if (language === 'pt') return `https://www.letras.mus.br/${match.dns}/${match.slug}/traducao.html`;
  if (language === 'en') return `https://www.letras.com/${match.dns}/${match.slug}/english.html`;
  return null;
}

/** Inner HTML of the first <div> whose class list contains `marker`. */
export function htmlBlock(html, marker) {
  const source = String(html || '');
  const opening = new RegExp(`<div\\s[^>]*class\\s*=\\s*"[^"]*\\b${marker}\\b[^"]*"[^>]*>`, 'i');
  const start = opening.exec(source);
  if (!start) return null;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = start.index + start[0].length;
  let depth = 1;
  let match;
  while ((match = tag.exec(source)) !== null) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return source.slice(start.index + start[0].length, match.index);
  }
  return null;
}

/** Original lyric lines of a Letras song page. */
export function letrasLyricLines(html) {
  const block = htmlBlock(html, 'lyric-original') || htmlBlock(html, 'cnt-letra');
  if (!block) return [];
  return block
    .replace(/<(script|style|h[1-6])\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .split('\n')
    .map(htmlText)
    .filter(Boolean);
}

/**
 * Verse pairs {original, translation} of a Letras translation page. Each verse
 * is <span class="verse"><span>translation</span><span class="romanization">
 * original</span></span>; the server writes `class = "verse"` with spaces.
 */
export function letrasVersePairs(html) {
  const pairs = [];
  const verse = /<span\s+class\s*=\s*"verse"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<span\s+class\s*=\s*"romanization"[^>]*>([\s\S]*?)<\/span>/gi;
  let match;
  while ((match = verse.exec(String(html || ''))) !== null) {
    const translation = htmlText(match[1]);
    const original = htmlText(match[2]);
    if (original && translation) pairs.push({ original, translation });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Matching translations to timed lines
// ---------------------------------------------------------------------------

function withoutAdLibs(text) {
  return String(text || '').replace(/\([^)]*\)/g, ' ');
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  a.forEach((word) => { if (b.has(word)) shared += 1; });
  return shared / (a.size + b.size - shared);
}

/** Letras verses plus each pair of consecutive verses (LRCLIB often joins two). */
export function translationCandidates(pairs) {
  const candidates = [];
  const list = Array.isArray(pairs) ? pairs : [];
  list.forEach((pair, index) => {
    const variants = [[pair.original, pair.translation]];
    const next = list[index + 1];
    if (next) variants.push([`${pair.original} ${next.original}`, `${pair.translation} ${next.translation}`]);
    for (const [original, translation] of variants) {
      candidates.push({
        words: new Set(words(original)),
        bare: new Set(words(withoutAdLibs(original))),
        translation,
      });
    }
  });
  return candidates;
}

/**
 * One translation per timed line ('' where Letras has none): exact match on
 * normalized text, then the closest verse by shared words, with and without
 * parenthesized ad-libs.
 */
export function alignTranslations(lines, pairs) {
  const exact = new Map();
  for (const pair of pairs || []) {
    const key = normalize(pair.original);
    if (key && !exact.has(key)) exact.set(key, pair.translation);
  }
  const candidates = translationCandidates(pairs);
  const memo = new Map();
  return (lines || []).map((line) => {
    const text = line && line.text;
    if (!text) return '';
    if (memo.has(text)) return memo.get(text);
    let found = exact.get(normalize(text)) || '';
    if (!found) {
      const all = new Set(words(text));
      const bare = new Set(words(withoutAdLibs(text)));
      let bestScore = 0;
      for (const candidate of candidates) {
        const score = Math.max(overlap(all, candidate.words), overlap(bare, candidate.bare));
        if (score > bestScore + 1e-9) {
          bestScore = score;
          found = candidate.translation;
        }
      }
      if (bestScore < 0.6) found = '';
    }
    memo.set(text, found);
    return found;
  });
}

// Short, frequent function words; enough to tell whether a song is already in
// the language a mode asks for.
const STOPWORDS = {
  pt: ['que', 'nao', 'voce', 'eu', 'meu', 'minha', 'pra', 'com', 'uma', 'tudo', 'quando', 'esta', 'sou', 'vai', 'nos', 'mais', 'te', 'do', 'da', 'e'],
  en: ['the', 'you', 'and', 'i', 'me', 'my', 'to', 'it', 'is', 'in', 'your', 'that', 'we', 'on', 'be', 'all', 'love', 'dont', 'im', 'of'],
  es: ['que', 'el', 'la', 'y', 'tu', 'yo', 'mi', 'en', 'de', 'los', 'las', 'por', 'una', 'como', 'pero', 'quiero', 'eres', 'esta', 'todo', 'contigo'],
};

export function detectLanguage(lines) {
  const counts = { pt: 0, en: 0, es: 0 };
  const sets = {};
  Object.keys(STOPWORDS).forEach((language) => { sets[language] = new Set(STOPWORDS[language]); });
  let total = 0;
  for (const line of lines || []) {
    for (const word of words(line && line.text)) {
      total += 1;
      Object.keys(sets).forEach((language) => { if (sets[language].has(word)) counts[language] += 1; });
    }
  }
  if (total < 20) return null;
  const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const [first, second] = ranked;
  if (counts[first] < total * 0.08 || counts[first] < counts[second] * 1.25) return null;
  return first;
}

/**
 * Merged [start, end] ranges of SponsorBlock "non-music section"
 * (music_offtopic) segments: film scenes, dialogue and intros in music videos.
 */
export function nonMusicRanges(segments) {
  const ranges = (Array.isArray(segments) ? segments : [])
    .filter(entry => entry && entry.category === 'music_offtopic' && Array.isArray(entry.segment))
    .map(entry => [Number(entry.segment[0]), Number(entry.segment[1])])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range.slice());
  }
  // A short silence at the very start of an official video is usually part of
  // the released track that LRCLIB timed as well; subtracting it would make
  // every line late. Only longer openings (film scenes, dialogue) count.
  const first = merged[0];
  if (first && first[0] <= LEAD_IN_START && first[1] - first[0] < LEAD_IN_MAX) merged.shift();
  return merged;
}

const LEAD_IN_START = 0.5;
const LEAD_IN_MAX = 6;

/**
 * Position in the song for a video time: the video time minus every
 * non-music range already played. Returns null inside a non-music range,
 * where no lyric line should show.
 */
export function songTime(videoTime, ranges) {
  let removed = 0;
  for (const [start, end] of ranges || []) {
    if (videoTime >= end) removed += end - start;
    else if (videoTime >= start) return null;
    else break;
  }
  return videoTime - removed;
}

export function nonMusicLength(ranges) {
  return (ranges || []).reduce((total, [start, end]) => total + (end - start), 0);
}

/** Index of the line being sung at `time`, or -1 before the first line. */
export function activeLineIndex(lines, time) {
  let low = 0;
  let high = (lines ? lines.length : 0) - 1;
  let index = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].t <= time) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return index;
}
