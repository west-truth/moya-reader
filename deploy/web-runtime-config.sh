#!/bin/sh
set -eu

# Only these browser-safe identifiers are projected. Never enumerate or serialize the full environment.
output_path="${1:-/usr/share/nginx/html/runtime-config.js}"
temporary_path="${output_path}.tmp.$$"
trap 'rm -f "$temporary_path"' EXIT HUP INT TERM
umask 022

encode_utf8() {
  # Base64 keeps quotes, newlines and non-ASCII bytes out of generated JavaScript string literals.
  printf '%s' "$1" | base64 | tr -d '\r\n'
}

dropbox_app_key="$(encode_utf8 "${MOYA_DROPBOX_APP_KEY:-}")"
dropbox_source_app_key="$(encode_utf8 "${MOYA_DROPBOX_SOURCE_APP_KEY:-}")"
google_drive_client_id="$(encode_utf8 "${MOYA_GOOGLE_DRIVE_CLIENT_ID:-}")"
google_drive_app_id="$(encode_utf8 "${MOYA_GOOGLE_DRIVE_APP_ID:-}")"
google_drive_developer_key="$(encode_utf8 "${MOYA_GOOGLE_DRIVE_DEVELOPER_KEY:-}")"
suwayomi_default_url="$(encode_utf8 "${MOYA_SUWAYOMI_DEFAULT_URL:-}")"

{
  printf '%s\n' '(function installMoyaRuntimeConfig() {'
  printf '%s\n' "  const decode = (value) => new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));"
  printf '%s\n' '  globalThis.__MOYA_RUNTIME_CONFIG__ = Object.freeze({'
  printf '%s\n' '    schemaVersion: 1,'
  printf "    dropboxAppKey: decode('%s'),\n" "$dropbox_app_key"
  printf "    dropboxSourceAppKey: decode('%s'),\n" "$dropbox_source_app_key"
  printf "    googleDriveClientId: decode('%s'),\n" "$google_drive_client_id"
  printf "    googleDriveAppId: decode('%s'),\n" "$google_drive_app_id"
  printf "    googleDriveDeveloperKey: decode('%s'),\n" "$google_drive_developer_key"
  printf "    suwayomiDefaultUrl: decode('%s'),\n" "$suwayomi_default_url"
  printf '%s\n' '  });'
  printf '%s\n' '})();'
} > "$temporary_path"

mv -f "$temporary_path" "$output_path"
trap - EXIT HUP INT TERM
