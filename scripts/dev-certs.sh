#!/usr/bin/env bash
set -euo pipefail
mkdir -p .certs
if [[ ! -f .certs/localhost-key.pem || ! -f .certs/localhost.pem ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout .certs/localhost-key.pem -out .certs/localhost.pem -days 365 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' 2>/dev/null
  chmod 600 .certs/localhost-key.pem
fi
echo 'Local HTTPS certificates are ready. Trust .certs/localhost.pem locally or use mkcert.'
