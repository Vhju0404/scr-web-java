#!/usr/bin/env bash
# Biên dịch lại HeadlessRunner (phần điều khiển headless của emulator) và cập nhật vào
# emulator/freej2me-headless.jar. Cần JDK 8+ (javac, jar) trong PATH.
# Dùng: bash tools/build-emulator.sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JAR="$ROOT/emulator/freej2me-headless.jar"
SRC="$ROOT/emulator-src/src"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

[ -f "$JAR.bak" ] || cp "$JAR" "$JAR.bak"

javac -encoding UTF-8 -source 1.8 -target 1.8 -nowarn \
  -cp "$JAR" -d "$OUT" "$SRC/org/recompile/mobile/HeadlessRunner.java"

(cd "$OUT" && jar uf "$JAR" org/recompile/mobile/HeadlessRunner*.class)
echo "Đã cập nhật $JAR (bản cũ: $JAR.bak)"
