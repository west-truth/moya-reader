# 모야 - 텍스트 및 만화 뷰어

모야(Moya)는 TXT·EPUB·PDF와 이미지 만화를 한곳에서 읽고 관리하는 개인용 셀프 호스팅 뷰어입니다.

This repository is the public web/server deployment snapshot: it contains the React reader, hosted API and worker, shared
document packages, and Docker Compose deployment files. Internal planning material and the native Tauri desktop and
Android projects are intentionally maintained outside this repository.

The application preserves imported source files. Browser UI code does not call external AI or TTS providers directly;
configured provider requests pass through the hosted worker boundary.

> Compatibility note: internal identifiers containing `noveldesk` remain unchanged so existing libraries, backups,
> sync data, credentials, queues, and Compose volumes continue to work. New user-facing names and downloaded filenames
> use Moya/`moya-*`.

> Moya currently targets a trusted individual or household deployment. It does not provide multi-user accounts,
> roles, quotas, or tenant isolation for running a public service.

## Features

- Library management with covers, collections, reading progress, recent books, and source-file download
- Chapter navigation, full-text search, bookmarks, highlights, notes, and reading statistics
- Reflowable TXT and EPUB reader with scroll/page layouts and TTS sentence highlighting
- Fixed-document PDF and comic viewer with continuous pages, zoom, rotation, spreads, and right-to-left reading
- PDF native text with OCR fallback, search, selection, annotations, and TTS
- ZIP/CBZ, RAR/CBR, and 7z/CB7 image archive support
- System speech plus optional hosted TTS caching and a global mini player
- Exact backup/restore, self-host synchronization, and optional AI speaker analysis

## Supported formats

| Format | Reading mode | Notes |
| --- | --- | --- |
| TXT / Markdown | Reflowable reader | Chapter parsing, search, annotations, statistics, TTS |
| DRM-free EPUB 2/3 | Reflowable reader | TOC, cover and images, ruby/language spans, footnotes, TTS |
| PDF | Fixed-document viewer | Range loading, native text/OCR, search, annotations, TTS |
| ZIP / CBZ | Comic viewer | Natural page order, covers, single/spread and LTR/RTL modes |
| RAR / CBR | Comic viewer | Single-volume RAR4/RAR5 image archives |
| 7z / CB7 | Comic viewer | Single-volume image archives |

Imported originals are stored unchanged in MinIO. Original-file download streams the stored bytes without
re-encoding or repackaging them.

## Docker Compose quick start

Requirements:

- Docker Engine or Docker Desktop
- Docker Compose v2
- At least 8 GB of host memory recommended; 12–16 GB when using the optional local TTS model

Clone the repository and create the local environment file:

```bash
git clone https://github.com/<owner>/<repository>.git moya-reader
cd moya-reader
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

For persistent use, change the PostgreSQL and MinIO passwords in `.env` first. `POSTGRES_PASSWORD` must match the
password inside `DATABASE_URL`; `MINIO_ROOT_*` and `S3_*` credentials must also stay aligned.

Validate and start the stack:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Open `http://127.0.0.1:8080`. Health endpoints are available through the web proxy:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/ready
```

The Korean first-run guide is in
[docs/operations/docker-compose-guide-ko.md](docs/operations/docker-compose-guide-ko.md). The more detailed operational
boundary is documented in
[docs/operations/docker-compose-deployment.md](docs/operations/docker-compose-deployment.md).

## Default security boundary

The base `compose.yaml` is intentionally local-only:

- Web UI binds to `127.0.0.1:8080`.
- MinIO Console binds to `127.0.0.1:9001`.
- API, PostgreSQL, Redis, MinIO API, and the optional TTS sidecar publish no host ports.
- `.env` and files under `secrets/vertex/` are excluded from Git and the Docker build context.
- Passwords in `.env.example` are development defaults and must be changed for persistent operation.

Novel files are not encrypted by the application. Use host access controls and disk/volume encryption when needed.

## Internet access

External access requires a TLS-terminating reverse proxy such as Caddy, nginx, or Traefik. Set a long bearer token and
the exact public HTTPS origin in `.env`:

```bash
openssl rand -hex 32
```

```dotenv
READER_AUTH_TOKEN=<long-random-token>
CORS_ALLOWED_ORIGINS=https://reader.example.com
```

Start with the fail-closed public override:

```bash
docker compose -f compose.yaml -f compose.public.yaml config --quiet
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

Minimal Caddy example:

```caddyfile
reader.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Keep `WEB_BIND_ADDRESS=127.0.0.1` when the reverse proxy runs on the same host. Do not expose ports 8080, 9001,
PostgreSQL, Redis, MinIO API, or the TTS service directly. `compose.public.yaml` activates server authentication but does
not provision TLS or a reverse proxy.

## Optional local Korean TTS

The local override adds a CPU-based MeloTTS Korean sidecar inside the Compose network:

```bash
docker compose -f compose.yaml -f compose.local-tts.yaml config --quiet
docker compose -f compose.yaml -f compose.local-tts.yaml up -d --build
docker compose -f compose.yaml -f compose.local-tts.yaml logs -f tts-model
```

The first start downloads the model and can take several minutes. Model data is cached in the `local-tts-models` named
volume, and `tts-model:9010` remains internal to Compose.

To combine public access and local TTS:

```bash
docker compose -f compose.yaml -f compose.public.yaml -f compose.local-tts.yaml up -d --build
```

The included override is specifically pinned for MeloTTS Korean on CPU. Replacing the model id alone does not install a
different engine; an alternative service must implement the expected `/voices` and `/synthesize` contract.

## Updating

Back up application data first, then reuse the same Compose file combination used at startup:

```bash
git pull --ff-only
docker compose config --quiet
docker compose up -d --build --remove-orphans
docker compose ps
docker compose logs --tail=100 api worker
```

For a persistent server, deploy a reviewed release tag instead of automatically following every `main` commit. Database
migrations run when the API starts.

## Backup boundary

An application backup archive is not a complete Docker disaster-recovery backup. Preserve these together:

| Target | Contents |
| --- | --- |
| PostgreSQL | Library, reading position, annotations, sync and job state |
| `minio-data` | Original files, document assets, and hosted TTS audio |
| `server-data` | Upload state and the generated provider-secret encryption key |
| `.env` | Passwords, bearer token, endpoints, and explicit encryption settings |
| `redis-data` | Durable queued-job AOF; recommended |
| `local-tts-models` | Re-downloadable local model cache; optional |

Do not use `docker compose down -v` as a normal stop command. The `-v` option deletes named volumes and server data.

## Development checks

The hosted source workspace uses Node.js 22 and pnpm 11:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Useful commands:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm server:build
pnpm check:server:production
pnpm check
```

The canonical hosted/server target is Ubuntu-compatible Linux x64 with glibc. GitHub Actions runs on Ubuntu 24.04,
and the Node build/runtime container stages use Debian Bookworm slim so native production dependencies resolve to the
same Linux/glibc family. The committed production-license inventory must therefore be generated on Ubuntu or WSL2
Ubuntu with `pnpm licenses:generate`. A Windows `pnpm check` still verifies all platform-neutral dependencies and the
licenses of the locally installed Windows native variants, but it cannot overwrite the canonical Linux inventory.

`pnpm test` runs the focused parser/import/health/source-download deployment suite. The broader development repository
maintains additional platform and research-path tests that are outside this hosted deployment snapshot.

Provider smoke commands may use credentials and incur external service costs. They are not part of `pnpm check` and
should only be run intentionally.

## Known limitations

- Authentication uses one shared bearer token intended for personal self-hosting.
- DRM-protected EPUB and PDF files are not supported.
- RAR/7z support focuses on single-volume archives; very large, solid, or encrypted archives need representative testing.
- OCR accuracy and runtime depend on scan quality, language data, and available memory.
- The included local TTS sidecar is Korean MeloTTS on CPU and can be slower than hosted commercial providers.
- Internet-facing operation still requires HTTPS, a host firewall, access control, monitoring, and tested backups.

## License and redistribution status

Moya source code in this repository is licensed under the
[Apache License 2.0](LICENSE). Third-party libraries, WebAssembly components, and optional model software remain under
their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `third_party/licenses/`.

This repository is ready for source publication and local source builds. The stricter binary redistribution gate
(`pnpm check:licenses:release`) intentionally remains blocked until the outstanding corresponding-source, container,
and artifact-notice work recorded in `third_party/license-release-policy.json` is complete. Do not treat the ordinary
source check as approval to publish official prebuilt images or installers.
