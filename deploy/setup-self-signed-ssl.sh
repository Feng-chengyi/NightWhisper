#!/usr/bin/env bash
set -euo pipefail

SSL_DIR="${SSL_DIR:-/etc/nginx/ssl}"
CERT_FILE="${CERT_FILE:-${SSL_DIR}/nightwhisper.crt}"
KEY_FILE="${KEY_FILE:-${SSL_DIR}/nightwhisper.key}"
COMMON_NAME="${COMMON_NAME:-NightWhisper}"
DAYS="${DAYS:-3650}"

mkdir -p "${SSL_DIR}"

openssl req \
  -x509 \
  -nodes \
  -days "${DAYS}" \
  -newkey rsa:2048 \
  -keyout "${KEY_FILE}" \
  -out "${CERT_FILE}" \
  -subj "/CN=${COMMON_NAME}"

chmod 600 "${KEY_FILE}"
chmod 644 "${CERT_FILE}"

echo "Self-signed certificate created:"
echo "  cert: ${CERT_FILE}"
echo "  key : ${KEY_FILE}"
