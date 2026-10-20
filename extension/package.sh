#!/bin/sh
# Fabrique l'Extension à installer dans Live : esbuild assemble src/extension.js et
# le SDK d'Ableton en un seul fichier, avec l'adresse du serveur dedans.
#   ./extension/package.sh https://ableton-collab.<ton-compte>.workers.dev
# → release/Collab-Room-<version>.ablx, à envoyer à tes potes.
set -eu

if [ $# -lt 1 ]; then
  echo "Donne l'adresse du serveur, ex. ./extension/package.sh https://ableton-collab.toi.workers.dev" >&2
  exit 1
fi
SERVER="${1%/}"
case "$SERVER" in http://* | https://*) ;; *) echo "L'adresse doit commencer par https://" >&2; exit 1 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
if [ ! -d "$ROOT/node_modules/@ableton-extensions/sdk" ]; then
  echo "Le SDK d'Ableton n'est pas installé : dépose-le dans vendor/ puis lance « npm run setup »." >&2
  exit 1
fi
if [ ! -x "$ROOT/node_modules/.bin/esbuild" ]; then
  echo "esbuild manque : lance « npm install »." >&2
  exit 1
fi

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/manifest.json")"
OUT="$ROOT/release/Collab-Room-$VERSION.ablx"
mkdir -p "$ROOT/release"
rm -f "$OUT"

# 1. Un seul fichier JavaScript : l'Extension + le SDK + la fenêtre (intégrée en texte).
"$ROOT/node_modules/.bin/esbuild" "$HERE/src/extension.js" \
  --bundle --platform=node --format=cjs --target=node24 --minify --log-level=warning \
  --loader:.html=text \
  --external:bufferutil --external:utf-8-validate \
  "--define:__COLLAB_SERVER__=\"$SERVER\"" \
  --outfile="$HERE/dist/extension.js"

# 2. Le .ablx, avec l'outil officiel d'Ableton.
if [ -x "$ROOT/node_modules/.bin/ableton-extensions-cli" ]; then
  "$ROOT/node_modules/.bin/ableton-extensions-cli" package "$HERE" -o "$OUT" >/dev/null
else
  (cd "$HERE" && zip -qr "$OUT" manifest.json dist)
fi
echo "✓ $OUT"
