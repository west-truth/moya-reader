# Docker Compose deployment

Status: implemented baseline
Last verified: 2026-08-04

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

`server-data` contains resumable upload chunks and, when `PROVIDER_SECRET_ENCRYPTION_KEY` is empty, the generated key
that decrypts hosted provider secrets. Losing PostgreSQL or that encryption key can make stored provider credentials
unrecoverable. `docker compose down -v` is therefore a destructive reset command, not an ordinary stop command.

## Local loopback startup

Copy `.env.example` to `.env`, review passwords and limits, then run:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

The web entry is `http://127.0.0.1:8080`. MinIO Console remains loopback-only at
`http://127.0.0.1:9001`. API, PostgreSQL and Redis have no host ports.

When changing the internal PostgreSQL password, update both `POSTGRES_PASSWORD` and the password encoded in
`DATABASE_URL`. Likewise, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` must stay aligned with
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` unless Moya is pointed at a separate S3 service.

All long-running services use `restart: unless-stopped`, bounded json-file logs and explicit memory limits. API and
worker receive a graceful stop window. Redis uses AOF with `appendfsync everysec`. Import jobs update a database
heartbeat every 30 seconds; a worker returns `processing` imports older than `IMPORT_RUNNING_STALE_MS` to BullMQ.

## Optional Korean local TTS

Start the base stack with the MeloTTS override:

```bash
docker compose -f compose.yaml -f compose.local-tts.yaml config --quiet
docker compose -f compose.yaml -f compose.local-tts.yaml up -d --build
docker compose -f compose.yaml -f compose.local-tts.yaml logs -f tts-model
```

The override builds the official MeloTTS source at the pinned `MELOTTS_COMMIT`, starts the Korean model on CPU and
sets the hosted default TTS provider to `local-endpoint`. The first start downloads the Korean model into
`local-tts-models`, so readiness can take several minutes. The service exposes no host port; API and worker call
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

Do not expose the base stack by merely changing `WEB_BIND_ADDRESS`. Set a long random token and the exact public HTTPS
origin, then use the public override behind Caddy, nginx, Traefik or another TLS proxy on the same host:

Set these values in `.env`:

```dotenv
READER_AUTH_TOKEN=<long-random-token>
CORS_ALLOWED_ORIGINS=https://reader.example.com
```

Then run `docker compose -f compose.yaml -f compose.public.yaml config --quiet` followed by
`docker compose -f compose.yaml -f compose.public.yaml up -d --build`.

The public override sets `SERVER_EXPOSURE=external` and uses required-variable interpolation, so Compose fails before
startup when the token or CORS origin is absent. Keep `WEB_BIND_ADDRESS=127.0.0.1` when the TLS reverse proxy runs on
the same host. Save the same bearer token in the Moya sync/server connection panel.

To combine public deployment and local TTS, apply both overrides in order:

```bash
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml up -d --build
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
```

The ordinary hosted E2E still covers TXT multi-chunk import and mock AI workflow. It does not prove MeloTTS image
build/model download, real synthesis, restart during a large PDF/archive import, or a full 512 MiB backup restore. Keep
those as practical deployment checks on the target host.

The Library linked-folder feature remains client-owned. A browser/Desktop/Android client scans its selected directory
and uploads changes. Mounting a host novel directory into the server container does not create a server-side watcher.

## Upstream local TTS references

- <https://github.com/myshell-ai/MeloTTS>
- <https://huggingface.co/myshell-ai/MeloTTS-Korean>
