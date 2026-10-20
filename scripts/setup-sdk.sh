#!/bin/sh
# Installe le SDK d'Ableton déposé dans vendor/ (il ne se télécharge que via le
# programme bêta d'Ableton, et sa licence interdit de le redistribuer : vendor/
# n'est donc jamais commité).
set -eu
cd "$(dirname "$0")/.."

TGZ="$(ls vendor/*extensions-sdk-*.tgz 2>/dev/null | sort | tail -n 1 || true)"
if [ -z "$TGZ" ]; then
  echo "Dépose d'abord le SDK dans vendor/ : le fichier ableton-extensions-sdk-<version>.tgz" >&2
  echo "qui se trouve dans le zip « Extensions SDK » téléchargé depuis Centercode." >&2
  exit 1
fi
CLI="$(ls vendor/*extensions-cli-*.tgz 2>/dev/null | sort | tail -n 1 || true)"
if [ -n "$CLI" ]; then
  npm install "./$TGZ" "./$CLI"
else
  npm install "./$TGZ"
fi
echo "✓ SDK installé depuis $TGZ${CLI:+ (+ $CLI)}"
