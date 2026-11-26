#!/usr/bin/env bash
# Download Taiwan CDC's dengue open data (od.cdc.gov.tw only answers Taiwanese IPs) and publish it for the
# denguemap data pipeline as two assets of the `latest` release of $DENGUE_OPENDATA_REPO:
#   Dengue_Daily.csv.gz     the file, gzipped (uploaded only when it changed)
#   Dengue_Daily.meta.json  {downloadedAt, sha256, lines} (uploaded on every successful run: proves freshness)
# Needs: curl, gzip, sha256sum, gh (GitHub CLI) with GH_TOKEN set to a fine-grained token that can write
# the contents of that repository only.  See README.md.
set -euo pipefail

REPO="${DENGUE_OPENDATA_REPO:-ancientsky/dengue-opendata}"
SRC="${DENGUE_OPENDATA_SRC:-https://od.cdc.gov.tw/eic/Dengue_Daily.csv}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/dengue-opendata"
mkdir -p "$STATE"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

: "${GH_TOKEN:?GH_TOKEN is not set (see README.md)}"

curl --fail --silent --show-error --location --retry 3 --retry-delay 60 --max-time 900 \
  -o "$tmp/Dengue_Daily.csv" "$SRC"

# sanity checks: the expected header and a plausible size (the file has every case since 1998)
if ! head -c 300 "$tmp/Dengue_Daily.csv" | grep -q '發病日,個案研判日,通報日'; then
  echo "unexpected content (not Dengue_Daily.csv?)" >&2
  exit 1
fi
lines=$(wc -l < "$tmp/Dengue_Daily.csv")
if [ "$lines" -lt 100000 ]; then
  echo "only $lines lines: incomplete download?" >&2
  exit 1
fi

sum=$(sha256sum "$tmp/Dengue_Daily.csv" | cut -d' ' -f1)
if [ "$(cat "$STATE/last.sha256" 2>/dev/null || true)" != "$sum" ]; then
  gzip -9 -n -c "$tmp/Dengue_Daily.csv" > "$tmp/Dengue_Daily.csv.gz"
  gh release upload latest "$tmp/Dengue_Daily.csv.gz" --repo "$REPO" --clobber
  echo "$sum" > "$STATE/last.sha256"
  echo "uploaded Dengue_Daily.csv.gz ($lines lines, sha256 $sum)"
else
  echo "Dengue_Daily.csv unchanged ($lines lines)"
fi

printf '{"downloadedAt":"%s","sha256":"%s","lines":%d}\n' "$(date --iso-8601=seconds)" "$sum" "$lines" > "$tmp/Dengue_Daily.meta.json"
gh release upload latest "$tmp/Dengue_Daily.meta.json" --repo "$REPO" --clobber
echo "uploaded Dengue_Daily.meta.json"
