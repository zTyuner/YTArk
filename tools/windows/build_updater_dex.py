"""Windows port of tools/build_android_updater.sh (Kotlin -> shaded JAR -> D8).

Same pinned inputs as the CI script: Kotlin 2.1.20-release-217 from
tools/kotlin, android.jar API 34 and build-tools 34.0.0. Host tests are not run
here; use tools/test_android_updater.sh on Linux/CI for those.

Usage: python tools/windows/build_updater_dex.py --sdk C:/path/to/sdk --out build/updater/classes.dex
  --sdk must contain build-tools/ (with d8.bat, lib/apksigner.jar) and platform/android.jar
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def run(cmd):
    print("+", " ".join(cmd)[:300], flush=True)
    subprocess.run(cmd, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdk", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--cert-file", default=os.path.join(ROOT, "signing", "YTArk-cert-sha256.txt"))
    args = parser.parse_args()

    kotlin_home = os.path.join(ROOT, "tools", "kotlin", "node_modules", "kotlin-compiler")
    with open(os.path.join(kotlin_home, "build.txt"), encoding="utf-8") as handle:
        if handle.read().strip() != "2.1.20-release-217":
            sys.exit("Kotlin 2.1.20-release-217 is required (run npm ci in tools/kotlin)")
    platform = os.path.join(args.sdk, "platform", "android.jar")
    d8 = os.path.join(args.sdk, "build-tools", "d8.bat")
    apksigner_jar = os.path.join(args.sdk, "build-tools", "lib", "apksigner.jar")
    for path in (platform, d8, apksigner_jar):
        if not os.path.isfile(path):
            sys.exit(f"Missing SDK file: {path}")

    with open(args.cert_file, encoding="utf-8") as handle:
        cert = "".join(line for line in handle if not line.lstrip().startswith("#"))
    cert = re.sub(r"[\s:]", "", cert).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", cert):
        sys.exit("Invalid certificate SHA-256 file")

    kotlinc = ["java", "-cp", os.path.join(kotlin_home, "lib", "*"),
               "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler"]
    stdlib = os.path.join(kotlin_home, "lib", "kotlin-stdlib.jar")
    source_root = os.path.join(ROOT, "android-updater", "src", "main", "kotlin")
    sources = sorted(os.path.join(dirpath, name)
                     for dirpath, _, names in os.walk(source_root)
                     for name in names if name.endswith(".kt"))

    work = tempfile.mkdtemp(prefix="ytark-updater-")
    try:
        # The apksig verifier core from build-tools, without its desktop CLI.
        apksig_jar = os.path.join(work, "apksig.jar")
        with zipfile.ZipFile(apksigner_jar) as source, \
                zipfile.ZipFile(apksig_jar, "w", zipfile.ZIP_DEFLATED) as target:
            for entry in source.infolist():
                if entry.filename.startswith("com/android/apksig"):
                    target.writestr(entry, source.read(entry))

        config = os.path.join(work, "UpdaterBuildConfig.kt")
        with open(config, "w", encoding="utf-8") as handle:
            handle.write("package io.github.twoarchiver.ytark.updater\n"
                         f'object UpdaterBuildConfig {{ const val CERT_SHA256 = "{cert}" }}\n')

        classpath = os.pathsep.join([platform, stdlib, apksig_jar])
        updater_jar = os.path.join(work, "updater.jar")
        run(kotlinc + ["-jvm-target", "1.8", "-no-reflect", "-classpath", classpath,
                       "-d", updater_jar] + sources + [config])

        shade = os.path.join(ROOT, "tools", "shade_kotlin.py")
        updater_isolated = os.path.join(work, "updater-isolated.jar")
        kotlin_isolated = os.path.join(work, "kotlin-isolated.jar")
        run([sys.executable, shade, updater_jar, updater_isolated])
        run([sys.executable, shade, stdlib, kotlin_isolated])

        dex_dir = os.path.join(work, "dex")
        os.makedirs(dex_dir)
        run(["cmd", "/c", d8, "--release", "--min-api", "24", "--lib", platform,
             "--output", dex_dir, updater_isolated, kotlin_isolated, apksig_jar])
        dex_files = [name for name in os.listdir(dex_dir) if name.endswith(".dex")]
        if dex_files != ["classes.dex"]:
            sys.exit(f"Unexpected D8 output: {dex_files}")
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        shutil.copyfile(os.path.join(dex_dir, "classes.dex"), args.out)
        print(f"Kotlin compilation and D8 passed: {args.out}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
