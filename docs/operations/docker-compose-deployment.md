# Docker Compose deployment

Status: current
Last verified: 2026-08-24

This is the operational reference for the self-host web/API/worker stack. The default deployment is intentionally
loopback-only. Public exposure requires the fail-closed override and a separate TLS-terminating reverse proxy.

For a Korean step-by-step first deployment, read [모야 Docker Compose 배포 가이드](docker-compose-guide-ko.md)
before this technical reference.

## Supported Linux baseline

The supported hosted baseline is an x86-64 Ubuntu server running Docker Engine and Docker Compose v2. GitHub source
checks are pinned to Ubuntu 24.04. The Node build and server runtime stages use Debian Bookworm slim, which—like
Ubuntu—uses glibc; the local TTS image is also Debian-based. This keeps native npm dependencies aligned with the
canonical `linux-x64-glibc` production-license inventory instead of mixing a Windows inventory with an Alpine/musl
container runtime.

The host distribution and container distribution are separate concerns: an Ubuntu host can run Alpine containers,
but Moya intentionally uses the Debian/glibc Node images for the hosted path. Other Linux distributions may work when
they can run the same Compose stack, but Ubuntu x86-64 is the documented and CI-covered deployment target.

## Services and durable data

The base stack contains:

- `web`: static remote-mode React application and `/api` reverse proxy
- `api`: Fastify API, migrations, readiness, sync and backup routes
- `worker`: durable import and AI/TTS provider jobs
- `postgres`: canonical library, reader, sync and provider metadata
- `redis`: BullMQ state with AOF persistence
- `minio`: source files, document assets and hosted TTS audio objects

Named volumes that must not be removed casually:

- `postgres-data`
- `redis-data`
- `minio-data`
- `server-data`
- `local-tts-models` when the optional local TTS override is used
- `suwayomi-data` when the optional Suwayomi/Mihon source override is used

`server-data` contains active resumable upload chunks and, when `PROVIDER_SECRET_ENCRYPTION_KEY` is empty, the generated
key that decrypts hosted provider secrets. Successful imports delete their temporary chunks immediately. Failed upload
chunks are retained only for the configured stale-session window and pruned periodically. Losing PostgreSQL or the
encryption key can make stored provider credentials unrecoverable. `docker compose down -v` is therefore a destructive
reset command, not an ordinary stop command.

## Local loopback startup

Copy `.env.example` to `.env`, review passwords and limits, then run:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

The web entry is `http://127.0.0.1:8080`. MinIO Console remains loopback-only at
`http://127.0.0.1:9001`. API, PostgreSQL and Redis have no host ports.

Keep `COMPOSE_PROJECT_NAME` stable for the lifetime of an installation. New installations use `moya-reader`. An
existing installation created under another directory/project name should record the value shown by
`docker compose ls` in `.env` before moving the checkout or changing `-p`; otherwise Compose attaches new empty named
volumes while the previous volumes remain under the old project prefix.

Leave `DATABASE_URL` empty to derive it from `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. Leave
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` empty to derive them from `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`. This keeps
the application and its bundled storage services on one credential source. Set the direct URL or S3 values only when
using external infrastructure.

`POSTGRES_*` initialization values apply only when the PostgreSQL data directory is empty. After a durable volume has
been initialized, rotate the database role password inside PostgreSQL first, then change `.env` to the same value and
recreate API/worker. Editing only `.env` leaves the old database role intact and makes API authentication fail. Never
use `docker compose down -v` as a credential-rotation shortcut.

All long-running services use `restart: unless-stopped`, bounded json-file logs and explicit memory limits. API and
worker receive a graceful stop window. Redis uses AOF with `appendfsync everysec`. Import jobs update a database
heartbeat every 30 seconds; a worker returns `processing` imports older than `IMPORT_RUNNING_STALE_MS` to BullMQ.
Intermediate BullMQ attempts remain queued/retrying in PostgreSQL and only the final attempt becomes failed.

`/health` is the API container bootstrap check. `/ready` is the client/operator readiness check and requires database,
Redis queue, object storage, and a fresh worker heartbeat. This separation lets the worker start without a dependency
cycle while preventing uploads from looking ready when no process can consume them.

## Optional Korean local TTS

Start the core stack first. Build the optional model separately, then apply the override only after that build succeeds:

```bash
docker compose -f compose.yaml -f compose.local-tts.yaml config --quiet
docker compose up -d --build
docker compose -f compose.yaml -f compose.local-tts.yaml build tts-model
docker compose -f compose.yaml -f compose.local-tts.yaml up -d --no-build
docker compose -f compose.yaml -f compose.local-tts.yaml logs -f tts-model
```

If the model-only build fails during a source clone, Python build or dependency installation, the Web/API/worker
started by the first command remain available. Fix and retry that build before applying the override.

The override builds the official MeloTTS source at the pinned `MELOTTS_COMMIT`, starts the Korean model on CPU and
sets the hosted default TTS provider to `local-endpoint`. The first start downloads the Korean model into
`local-tts-models`, so its own readiness can take several minutes. API and worker deliberately do not wait for this
optional service: Library, Reader and document import remain available while TTS reports an unavailable endpoint and
can be retried after `tts-model` becomes healthy. The service exposes no host port; API and worker call
`http://tts-model:9010/synthesize`, while `/voices` returns the model speaker ids.

Important settings:

- `LOCAL_TTS_PROVIDER_DEFAULT=local-endpoint`: overrides the ordinary `system` default only when this Compose file is used
- `LOCAL_TTS_PROVIDER_ENABLED=local-endpoint`: enables the internal endpoint only in this Compose variant
- `MELOTTS_DEVICE=cpu`: default and portable path; a CUDA image/device reservation is not provided yet
- `MELOTTS_LANGUAGE=KR`: model locale
- `TTS_LOCAL_ENDPOINT_MODEL_ID=melotts-korean`: must match the adapter model id
- `LOCAL_TTS_MEMORY_LIMIT=4g`: container memory ceiling
- `MELOTTS_MAX_TEXT_CHARACTERS=20000`: adapter request ceiling

The sidecar supports WAV, MP3, OGG and FLAC output. Synthesis is serialized inside the model process because the loaded
PyTorch model is shared. Run additional model replicas only after defining an explicit queue/capacity policy.

MeloTTS source and the `myshell-ai/MeloTTS-Korean` model card both declare MIT licensing. The repository pins the
source commit but does not redistribute the downloaded model in the default web/desktop artifacts.

## Public HTTPS deployment

Do not expose the base stack by merely changing `WEB_BIND_ADDRESS`. Set a long random token, then use the public
override behind Caddy, nginx, Traefik or another TLS proxy on the same host:

Set these values in `.env`:

```dotenv
READER_AUTH_TOKEN=<long-random-token>
POSTGRES_PASSWORD=<long-random-database-password>
MINIO_ROOT_USER=<non-default-storage-user>
MINIO_ROOT_PASSWORD=<long-random-storage-password>
```

Then run `docker compose -f compose.yaml -f compose.public.yaml config --quiet` followed by
`docker compose -f compose.yaml -f compose.public.yaml up -d --build`.

The public override sets `SERVER_EXPOSURE=external` and uses required-variable interpolation, so Compose fails before
startup when the bearer token, PostgreSQL password or MinIO credentials are absent. The API derives its internal
database and object-storage credentials from those same required values unless explicit external infrastructure values
are supplied. A web UI and `/api` served from the same host are accepted as same-origin without a CORS entry. Set
`CORS_ALLOWED_ORIGINS` only for an actual cross-origin browser client. Keep
`WEB_BIND_ADDRESS=127.0.0.1` when the TLS reverse proxy runs on the same host. Save the same bearer token in the Moya
sync/server connection panel; saving it retries a failed first bootstrap automatically.

The Ubuntu host nginx reference is [`deploy/host-nginx.example.conf`](../../deploy/host-nginx.example.conf). It proxies
only to `127.0.0.1:8080`, allows 32 MiB ordinary requests and 512 MiB backup archives, disables request buffering for
uploads/backups, and preserves the public scheme. Replace its domain and certificate paths, validate with `nginx -t`,
then reload nginx. Moya browser uploads use 2 MiB resumable chunks, so the committed 32 MiB ordinary-request limit is
required; nginx's usual 1 MiB default is not sufficient.
For WireGuard-only access, bind nginx to the server's WireGuard address or allow 443 only on `wg0`; do not publish
Compose port 8080 or the storage/database ports to the VPN or public interfaces.

### Browser-visible runtime configuration

The Web container generates `/runtime-config.js` on every start from an explicit allowlist: Dropbox app identifiers,
Google Drive OAuth/Picker identifiers, and the default Suwayomi origin. This lets a self-host change those public values
without rebuilding the image. Nginx marks the file `no-store`, the service worker bypasses it, and the application loads
it before its module bundle.

Only the `MOYA_DROPBOX_*`, `MOYA_GOOGLE_DRIVE_*`, and `MOYA_SUWAYOMI_DEFAULT_URL` values documented in `.env.example`
belong in this boundary. Never add an app/client secret, Reader bearer token, provider credential or arbitrary process
environment value. Local Vite/Tauri development retains the corresponding `VITE_*` fallbacks.

To combine public deployment and local TTS, keep the same core-first boundary:

```bash
docker compose -f compose.yaml -f compose.public.yaml up -d --build
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml build tts-model
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml up -d --no-build
```

## Optional Suwayomi/Mihon source runtime

`compose.suwayomi.yaml` adds the official stable Suwayomi Server as a compatibility runtime for Mihon sources already
installed by the operator. It publishes no host port. Moya Web and Suwayomi join a pre-created external Docker network
used by Nginx Proxy Manager and expose the default aliases `moya-web:80` and `moya-suwayomi:4567` there.

Set explicit `SUWAYOMI_AUTH_USERNAME` and `SUWAYOMI_AUTH_PASSWORD`; the overlay fails during Compose interpolation when
either is absent. The default `ui_login` mode persists sealed tokens in Moya. `basic_auth` is also supported, but its
password remains session-only in the browser. Suwayomi data lives under the `suwayomi-data` named volume at the
official container data path. The overlay intentionally does not force an extension-store environment value, so the
WebUI-owned setting survives container recreation.

```bash
docker network create npm_proxy # omit when it already exists
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml config --quiet
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml up -d --build
```

Use a separate trusted HTTPS origin for Suwayomi and set it as `MOYA_SUWAYOMI_DEFAULT_URL`. Subpath hosting is not
supported by the current root-relative GraphQL/chapter contract. The complete Nginx Proxy Manager, WireGuard, OAuth
origin and update example is [Nginx Proxy Manager + WireGuard deployment](nginx-proxy-manager-wireguard.md).

## Vertex credentials

Put exactly one service-account JSON file under `./secrets/vertex` or change `VERTEX_CREDENTIALS_HOST_DIR`. Compose
mounts this directory read-only at `/run/secrets/vertex` in both API and worker. The directory contents are ignored by
Git and the Docker build context.

When `GOOGLE_APPLICATION_CREDENTIALS` is set, it must be the container path, for example:

```text
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/vertex/service-account.json
```

Do not put a Windows host path in that variable.

## Backup and restore

The application backup archive preserves reader/library content but intentionally excludes provider secrets/settings
and hosted TTS audio cache. A recoverable server backup therefore needs a tested combination of:

1. PostgreSQL backup or storage snapshot
2. MinIO data backup or object-storage replication
3. `server-data`, especially its provider encryption key
4. `.env` or separately managed deployment secrets

Redis AOF is useful for short outages but is not a substitute for PostgreSQL/MinIO backup. The local model cache can
be downloaded again and is optional in disaster recovery.

Normal API requests remain limited to 32 MiB, while `/api/backups/*` accepts the server archive limit of 512 MiB and
disables nginx request buffering. Backup restore is not yet a streaming parser and can temporarily use substantial API
memory; the default API limit is 2 GiB. Test a representative restore before relying on the backup.

## Verification and known limits

Static/config checks:

```bash
pnpm check:hosted
docker compose config --quiet
docker compose -f compose.yaml -f compose.local-tts.yaml config --quiet
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml config --quiet
pnpm check:hosted:e2e -- --public
```

Live check against a running protected instance:

```bash
HOSTED_WEB_URL=https://moya.example.com \
HOSTED_API_AUTH_TOKEN="$READER_AUTH_TOKEN" \
pnpm check:hosted:live
```

The hosted live smoke validates protected sync capability negotiation, TXT multi-chunk upload/import, manifest/page and
search reads, reader mutations, sync events, and cleanup. The ordinary hosted E2E also covers the mock AI workflow. It
does not prove MeloTTS model download/real synthesis, restart during a large PDF/archive import, the operator's outer
nginx configuration, or a full 512 MiB backup restore. Keep those as practical checks on the target host.

The Library linked-folder feature remains client-owned. A browser/Desktop/Android client scans its selected directory
and uploads changes. Mounting a host novel directory into the server container does not create a server-side watcher.

## Upstream local TTS references

- <https://github.com/myshell-ai/MeloTTS>
- <https://huggingface.co/myshell-ai/MeloTTS-Korean>
