#!/usr/bin/env bash
# 配信ディレクトリの .html から sitemap.xml を作る。
# 使い方: bash build/generate-sitemap.sh <対象ディレクトリ> <ベースURL> <出力先>
set -euo pipefail

DIR="${1:-public}"
BASE_URL="${2:-https://tools.yxmxgxn.workers.dev}"
BASE_URL="${BASE_URL%/}"
OUTPUT="${3:-$DIR/sitemap.xml}"

today=$(date -u +%Y-%m-%d)

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  find "$DIR" -type f -name '*.html' | sed "s|^$DIR/||" | sort | while IFS= read -r path; do
    case "$path" in
      404.html) continue ;;
    esac
    if [ "$path" = "index.html" ]; then
      loc="$BASE_URL/"
    elif [ "${path%/index.html}" != "$path" ]; then
      loc="$BASE_URL/${path%index.html}"   # foo/index.html → /foo/
    else
      loc="$BASE_URL/$path"
    fi
    printf '  <url>\n    <loc>%s</loc>\n    <lastmod>%s</lastmod>\n  </url>\n' "$loc" "$today"
  done
  echo '</urlset>'
} > "$OUTPUT"

echo "sitemap generated: $OUTPUT"
