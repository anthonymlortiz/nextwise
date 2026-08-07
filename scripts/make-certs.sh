#!/usr/bin/env bash
#
# Generates a locally-trusted certificate for https://localhost:5173 using
# mkcert, so the browser raises no warning during the Microsoft sign-in popup.
#
# Optional: without it the dev server falls back to a self-signed certificate,
# which works but makes you accept a browser warning once per profile.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert is not installed. Install it with:"
  echo
  echo "  brew install mkcert nss"
  echo
  echo "then run this script again. (nss is only needed for Firefox.)"
  exit 1
fi

# Installs mkcert's local CA into the system trust store. Prompts for your
# password the first time; subsequent runs are a no-op.
mkcert -install

mkdir -p certs
mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1

echo
echo "Done. Restart the dev server with: npm run dev"
