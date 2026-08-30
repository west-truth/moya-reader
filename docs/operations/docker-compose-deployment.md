# Docker Compose deployment

Status: current
Last verified: 2026-08-31

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
- `metadata-collector-data` when the optional metadata collector is enabled
- `local-tts-models` when the optional local TTS override is used

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
using external infrastructure. Compose passes the bundled database settings as separate `PG*` fields, and the server
URL-encodes reserved password characters before creating the PostgreSQL connection string.

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

The 2026-08-31 self-host lifecycle update includes forward-only migrations `0037`-`0040`. They make content revision IDs
unique across same-ID book reincarnations, add generation-aware object-delete claims, persist book-generation upload
tickets, and retain explicit cover removal in `library_books.cover_removed_at`. Deploy Web/API/worker from the same
checkout and let API migrations finish before accepting new imports. A
known-book replacement session created by an older server without a generation ticket fails closed and must be started
again; it is not allowed to guess that a purged or recreated target is the old book. The worker is also required to drain
the durable object-delete outbox, so running API without a healthy worker can retain orphan candidates even though it does
not make referenced content unsafe.

Suwayomi remains optional. The generation/content fences, exact section read state, source-cover retry and association
purge recovery are Moya contracts and do not require a Suwayomi container. When the override is enabled, the source
runtime still stays outside the PostgreSQL/Redis/MinIO/API network described below.

## Optional webnovel cover and metadata collector

Enable the trusted `웹소설 표지·작품 정보` extension in self-host Web with the optional Compose override:

```bash
docker compose -f compose.yaml -f compose.metadata-collector.yaml config --quiet
docker compose -f compose.yaml -f compose.metadata-collector.yaml up -d --build
```

For public ingress, append the same override after `compose.public.yaml`; no collector-specific proxy setting is
added.

```bash
docker compose -f compose.yaml -f compose.public.yaml -f compose.metadata-collector.yaml up -d --build
```

The override starts a non-root Python service without a host port and sets only the API container's internal
`WEBNOVEL_METADATA_COLLECTOR_URL`. Browser code calls the authenticated same-origin
`/api/integrations/webnovel-metadata` gateway. The gateway allowlists health, resolve, batch-resolve and bounded cover
download routes; it never forwards the browser cookie or Authorization header to the Python service.

This path is independent of the outer TLS proxy. Nginx Proxy Manager, Caddy, Traefik, host nginx or direct loopback
access all use the existing Moya Web ingress and `/api` route. Do not expose port 8000, create a collector domain or
put the internal service URL in `runtime-config.js`. Without the override, the gateway returns a bounded 503 only for
the extension and the rest of Moya remains available.

The default container installs the public metadata dependencies only and deliberately reports adult authentication
unavailable. Deployments that need authenticated 19+ search can add the separate auth layer after the core collector:

```bash
docker compose \
  -f compose.yaml \
  -f compose.metadata-collector.yaml \
  -f compose.metadata-collector-auth.yaml \
  up -d --build
```

For public ingress, insert `compose.public.yaml` after `compose.yaml` and keep the two collector overrides in the order
shown. The auth image adds Playwright, Chromium and Xvfb, uses 1 GiB shared memory and defaults to a 1536 MiB container
limit. It is intentionally not part of the base or public-metadata profile.

The user operates the dedicated browser through bounded JPEG frames and allowlisted click, text, key, scroll and basic
navigation actions under the existing authenticated Moya API. It does not add a host port, domain, WebSocket or proxy
route. Browser cookies and Moya Authorization/session headers are never forwarded between those boundaries. Login
keystrokes do traverse the user's Moya connection to the dedicated browser, so use trusted loopback/WireGuard or HTTPS,
not plaintext HTTP over an untrusted network. Moya does not persist those inputs in application settings or the server
database.

The collector is attached to a dedicated bridge network rather than the database/Redis/MinIO network. Remote-browser
requests reject non-Web URLs, single-label/internal hosts, literal or DNS-resolved non-global addresses; service workers
and WebSockets are disabled for that profile. The API remains dual-homed only so its bounded gateway can reach the
collector. This is application defense in depth, not a substitute for host firewall/egress policy when the Docker host
can reach sensitive private networks.

The browser profile and cookies remain in the private `metadata-collector-data` volume. They are not Cloud Vault data
and are not included in ordinary device sync. Current self-host scope is one owner account and one collector profile.
`Login complete` enables the platform but is not proof that its session or adult verification succeeded; live-account
search still needs operator verification. Use the extension's session-delete action before transferring or retiring a
server.

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

Do not expose the base stack by merely changing `WEB_BIND_ADDRESS`. Set a long random owner-setup/recovery token, then use the public
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

When Nginx Proxy Manager itself runs in Docker, append `-f compose.npm.yaml` so only Web joins the external NPM
network. Append `-f compose.suwayomi.yaml` only when the optional compatibility runtime is needed. Suwayomi joins only
the NPM network, not the Moya database/queue/storage network.

The public override sets `SERVER_EXPOSURE=external` and uses required-variable interpolation, so Compose fails before
startup when the one-time owner setup/recovery token, PostgreSQL password or MinIO credentials are absent. The API derives its internal
database and object-storage credentials from those same required values unless explicit external infrastructure values
are supplied. A web UI and `/api` served from the same host are accepted as same-origin without a CORS entry. Set
`CORS_ALLOWED_ORIGINS` only for an actual cross-origin browser client. Keep
`WEB_BIND_ADDRESS=127.0.0.1` when the TLS reverse proxy runs on the same host. On the first browser only, enter the
`READER_AUTH_TOKEN` as the setup code and create the single owner username/password. Later devices use that account and
receive a 30-day `HttpOnly; Secure; SameSite=Strict` session cookie, so the recovery token is not copied into each browser.
Create the owner account before exposing a new DNS name beyond loopback or the private WireGuard boundary.

The Ubuntu host nginx reference is [`deploy/host-nginx.example.conf`](../../deploy/host-nginx.example.conf). It proxies
only to `127.0.0.1:8080`, allows 32 MiB ordinary requests and 512 MiB backup archives, disables request buffering for
uploads/backups, and preserves the public scheme. Replace its domain and certificate paths, validate with `nginx -t`,
then reload nginx. Moya browser uploads use 2 MiB resumable chunks, so the committed 32 MiB ordinary-request limit is
required; nginx's usual 1 MiB default is not sufficient.

To combine public deployment and local TTS, keep the same core-first boundary:

```bash
docker compose -f compose.yaml -f compose.public.yaml up -d --build
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml build tts-model
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml up -d --no-build
```

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

Take the PostgreSQL/MinIO/server-data backup before applying an update. Database migrations are forward-only at
runtime: after a newer migration is recorded, checking out only older application code can intentionally fail startup.
Rollback therefore means restoring the matching pre-update data snapshot as well, or applying a forward fix on the
new schema.

Redis AOF is useful for short outages but is not a substitute for PostgreSQL/MinIO backup. The local model cache can
be downloaded again and is optional in disaster recovery.

Normal API requests remain limited to 32 MiB, while `/api/backups/*` accepts the server archive limit of 512 MiB and
disables nginx request buffering. Backup restore is not yet a streaming parser and can temporarily use substantial API
memory; the default API limit is 2 GiB. Test a representative restore before relying on the backup.

Hosted import still assembles the uploaded source for the parser, so `MAX_UPLOAD_BYTES=500 MiB` is a protocol ceiling,
not a promise that every compressed 500 MiB archive fits in the default 3 GiB worker. Fixed-document page reads are
streamed from object storage, but archive parsing and backup restore remain memory-sensitive. Do not raise the upload
limit without a representative large-file gate and worker memory observation.

Before relying on restore as a lifecycle recovery mechanism, run a representative post-`0040` restore audit that includes
a hard-purged and same-ID recreated book, its explicit cover-removal state, MinIO objects, source association and exact
section read state. Migration and normal import coverage does not by itself prove that every legacy backup shape
reconstructs the new generation ledger and removal marker.

## Verification and known limits

Static/config checks:

```bash
pnpm check:hosted
docker compose config --quiet
docker compose -f compose.yaml -f compose.local-tts.yaml config --quiet
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
