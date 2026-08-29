import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const files = {
  compose: read('compose.yaml'),
  composeLocalTTS: read('compose.local-tts.yaml'),
  composePublic: read('compose.public.yaml'),
  composeSuwayomi: read('compose.suwayomi.yaml'),
  dockerignore: read('.dockerignore'),
  localTTSDockerfile: read('deploy/local-tts.Dockerfile'),
  localTTSServer: read('deploy/local-tts/server.py'),
  webDockerfile: read('deploy/web.Dockerfile'),
  webRuntimeConfig: read('deploy/web-runtime-config.sh'),
  serverDockerfile: read('deploy/server.Dockerfile'),
  nginx: read('deploy/nginx.conf'),
  hostNginxExample: read('deploy/host-nginx.example.conf'),
  envExample: read('.env.example'),
  indexHtml: read('index.html'),
  packageJson: read('package.json'),
  publicRuntimeConfig: read('public/runtime-config.js'),
  serviceWorker: read('public/sw.js'),
  serverSchema: read('apps/server/src/db/schema.sql'),
  hostedE2E: read('scripts/hosted-e2e.mjs'),
  liveSmoke: read('scripts/hosted-live-smoke.mjs'),
  aiWorkflowSmoke: read('scripts/hosted-ai-workflow-smoke.mjs'),
  serverIndex: read('apps/server/src/index.ts'),
  server: read('apps/server/src/server.ts'),
  serverQueue: read('apps/server/src/queue.ts'),
  serverUploadImport: read('src/services/import/server-upload-import-service.ts'),
  composeGuideKo: read('docs/operations/docker-compose-guide-ko.md'),
  composeDeployment: read('docs/operations/docker-compose-deployment.md'),
  npmWireGuardGuide: read('docs/operations/nginx-proxy-manager-wireguard.md'),
};

const checks = [];

function check(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function includes(file, needle) {
  return file.includes(needle);
}

function matches(file, pattern) {
  return pattern.test(file);
}

function blockAfter(file, header) {
  const lines = file.split(/\r?\n/);
  const index = lines.findIndex((line) => line === header);
  if (index < 0) return '';
  const baseIndent = lines[index].match(/^\s*/)?.[0].length ?? 0;
  const out = [lines[index]];
  for (const line of lines.slice(index + 1)) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= baseIndent) break;
    out.push(line);
  }
  return out.join('\n');
}

function envValue(text, key) {
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match?.[1]?.trim();
}

function composeService(name) {
  return blockAfter(files.compose, `  ${name}:`);
}

function assertService(name) {
  const service = composeService(name);
  check(`compose service: ${name}`, Boolean(service), `missing service block ${name}:`);
  return service;
}

const web = assertService('web');
const api = assertService('api');
const worker = assertService('worker');
const postgres = assertService('postgres');
const redis = assertService('redis');
const minio = assertService('minio');
const volumes = blockAfter(files.compose, 'volumes:');
const commonEnvironment = blockAfter(files.compose, 'x-server-common-environment: &server-common-environment');
const serverVolumes = blockAfter(files.compose, 'x-server-volumes: &server-volumes');
const localTTS = blockAfter(files.composeLocalTTS, '  tts-model:');
const suwayomiWeb = blockAfter(files.composeSuwayomi, '  web:');
const suwayomi = blockAfter(files.composeSuwayomi, '  suwayomi:');
const suwayomiNetworks = blockAfter(files.composeSuwayomi, 'networks:');
const suwayomiVolumes = blockAfter(files.composeSuwayomi, 'volumes:');

check('web uses deploy/web.Dockerfile', includes(web, 'dockerfile: deploy/web.Dockerfile'));
check(
  'web defaults its published port to loopback',
  matches(web, /['"]\$\{WEB_BIND_ADDRESS:-127\.0\.0\.1}:8080:80['"]/),
);
check('web waits for healthy api', matches(web, /api:\s*\n\s+condition: service_healthy/));
check('web restarts unless stopped', includes(web, 'restart: unless-stopped'));
for (const key of [
  'MOYA_DROPBOX_APP_KEY',
  'MOYA_DROPBOX_SOURCE_APP_KEY',
  'MOYA_GOOGLE_DRIVE_CLIENT_ID',
  'MOYA_GOOGLE_DRIVE_APP_ID',
  'MOYA_GOOGLE_DRIVE_DEVELOPER_KEY',
  'MOYA_SUWAYOMI_DEFAULT_URL',
]) {
  check(`web receives public runtime env ${key}`, includes(web, `${key}:`));
}

check('api uses deploy/server.Dockerfile', includes(api, 'dockerfile: deploy/server.Dockerfile'));
check('api starts compiled server artifact', matches(api, /command:\s*\[['"]node['"],\s*['"]dist\/index\.js['"]\]/));
check('api is not directly published to the host', !matches(api, /^ {4}ports:/m));
check('api documents loopback proxy as the only host ingress', includes(api, 'Deliberately no ports'));
check('api container healthcheck uses bootstrap-safe /health', includes(api, "fetch('http://127.0.0.1:8787/health')"));
for (const dependency of ['postgres', 'redis', 'minio']) {
  check(
    `api waits for healthy ${dependency}`,
    matches(api, new RegExp(`${dependency}:\\s*\\n\\s+condition: service_healthy`)),
  );
}
for (const key of [
  'HOST: 0.0.0.0',
  'PORT: 8787',
  'SERVER_EXPOSURE: ${SERVER_EXPOSURE:-loopback}',
  'CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-http://127.0.0.1:8080,http://localhost:8080}',
  'READER_AUTH_TOKEN: ${READER_AUTH_TOKEN:-}',
]) {
  check(`api env ${key}`, includes(api, key));
}
check('api uses the shared server environment', includes(api, '<<: *server-common-environment'));
check('api restarts unless stopped', includes(api, 'restart: unless-stopped'));
check('api has a bounded graceful stop window', includes(api, 'stop_grace_period: 60s'));

for (const key of [
  'DATABASE_URL: ${DATABASE_URL:-postgres://${POSTGRES_USER:-noveldesk}:${POSTGRES_PASSWORD:-noveldesk}@postgres:5432/${POSTGRES_DB:-noveldesk}}',
  'REDIS_URL: ${REDIS_URL:-redis://redis:6379}',
  'S3_ENDPOINT: ${S3_ENDPOINT:-http://minio:9000}',
  'S3_BUCKET: ${S3_BUCKET:-noveldesk-uploads}',
  'S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER:-minio}}',
  'S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:-${MINIO_ROOT_PASSWORD:-minio-password}}',
  'S3_FORCE_PATH_STYLE: ${S3_FORCE_PATH_STYLE:-true}',
  'SERVER_DATA_DIR: /data/server',
  'LOCAL_TTS_ALLOWED_HOSTS: ${LOCAL_TTS_ALLOWED_HOSTS:-}',
  'PROVIDER_MAX_ACTIVE_ATTEMPTS: ${PROVIDER_MAX_ACTIVE_ATTEMPTS:-4}',
  'PROVIDER_MAX_ATTEMPTS_PER_MINUTE: ${PROVIDER_MAX_ATTEMPTS_PER_MINUTE:-60}',
  'PROVIDER_MAX_ATTEMPTS_PER_UTC_DAY: ${PROVIDER_MAX_ATTEMPTS_PER_UTC_DAY:-1000}',
  'PROVIDER_WORKER_CONCURRENCY: ${PROVIDER_WORKER_CONCURRENCY:-1}',
  'IMPORT_RUNNING_STALE_MS: ${IMPORT_RUNNING_STALE_MS:-300000}',
  'IMPORT_WORKER_CONCURRENCY: ${IMPORT_WORKER_CONCURRENCY:-1}',
  'MAX_CHUNK_BYTES: ${MAX_CHUNK_BYTES:-16777216}',
  'MAX_UPLOAD_BYTES: ${MAX_UPLOAD_BYTES:-524288000}',
  'STALE_UPLOAD_MAX_AGE_MS: ${STALE_UPLOAD_MAX_AGE_MS:-604800000}',
]) {
  check(`shared server env ${key}`, includes(commonEnvironment, key));
}

check('worker uses deploy/server.Dockerfile', includes(worker, 'dockerfile: deploy/server.Dockerfile'));
check(
  'worker starts compiled worker artifact',
  matches(worker, /command:\s*\[['"]node['"],\s*['"]dist\/worker\.js['"]\]/),
);
check('worker waits for healthy api', matches(worker, /api:\s*\n\s+condition: service_healthy/));
check('worker disables startup migrations', matches(worker, /RUN_MIGRATIONS_ON_START:\s*['"]false['"]/));
check('worker uses the shared server environment', includes(worker, '<<: *server-common-environment'));
check('worker restarts unless stopped', includes(worker, 'restart: unless-stopped'));
check('worker has a bounded graceful stop window', includes(worker, 'stop_grace_period: 90s'));

check('postgres image is pinned major alpine', includes(postgres, 'image: postgres:16-alpine'));
check('postgres has pg_isready healthcheck', includes(postgres, 'pg_isready -U ${POSTGRES_USER:-noveldesk}'));
check('postgres restarts unless stopped', includes(postgres, 'restart: unless-stopped'));
check('redis image is pinned major alpine', includes(redis, 'image: redis:7-alpine'));
check('redis has ping healthcheck', matches(redis, /['"]redis-cli['"],\s*['"]ping['"]/));
check('redis enables AOF persistence', includes(redis, "'--appendonly', 'yes'"));
check('redis mounts its durable data volume', includes(redis, 'redis-data:/data'));
check('redis restarts unless stopped', includes(redis, 'restart: unless-stopped'));
check('minio has live healthcheck', includes(minio, 'http://127.0.0.1:9000/minio/health/live'));
check(
  'minio console defaults to loopback',
  matches(minio, /['"]\$\{MINIO_CONSOLE_BIND_ADDRESS:-127\.0\.0\.1}:9001:9001['"]/),
);
check('minio restarts unless stopped', includes(minio, 'restart: unless-stopped'));

for (const volume of ['postgres-data:', 'redis-data:', 'minio-data:', 'server-data:']) {
  check(`compose volume ${volume}`, includes(volumes, volume));
}
check('shared server volumes mount server-data', includes(serverVolumes, 'server-data:/data/server'));
check('shared server volumes mount Vertex credentials read-only', includes(serverVolumes, '/run/secrets/vertex'));
check('api mounts shared server volumes', includes(api, 'volumes: *server-volumes'));
check('worker mounts shared server volumes', includes(worker, 'volumes: *server-volumes'));

for (const ignoredPath of [
  'node_modules',
  '**/node_modules',
  'dist',
  'vertex env/',
  'secrets/',
  '.server-test-data/',
  'test_novel/',
  'smart-novel-reader-codex-pack/',
  'ui-reference/',
  'fixtures/generated/',
]) {
  check(`.dockerignore excludes ${ignoredPath}`, includes(files.dockerignore, ignoredPath));
}
check(
  '.dockerignore excludes native build trees',
  includes(files.dockerignore, 'src-tauri/') ||
    (includes(files.dockerignore, 'src-tauri/target') && includes(files.dockerignore, 'src-tauri/gen')),
);

check('web Dockerfile builds remote backend', includes(files.webDockerfile, 'ENV VITE_READER_BACKEND=remote'));
check('web Dockerfile points API base to /api', includes(files.webDockerfile, 'ENV VITE_API_BASE_URL=/api'));
check('web Dockerfile runs pnpm build', includes(files.webDockerfile, 'RUN pnpm build'));
check(
  'web Dockerfile installs shared workspaces',
  includes(files.webDockerfile, 'COPY packages/contracts/package.json packages/contracts/package.json') &&
    includes(
      files.webDockerfile,
      'COPY packages/extension-contracts/package.json packages/extension-contracts/package.json',
    ) &&
    includes(files.webDockerfile, 'COPY packages/text-core/package.json packages/text-core/package.json'),
);
check(
  'web Dockerfile serves dist with nginx',
  includes(files.webDockerfile, 'COPY --from=build /app/dist /usr/share/nginx/html'),
);
check(
  'web Dockerfile installs the runtime config entrypoint',
  includes(files.webDockerfile, 'deploy/web-runtime-config.sh /docker-entrypoint.d/40-moya-runtime-config.sh') &&
    includes(files.webDockerfile, 'chmod 755 /docker-entrypoint.d/40-moya-runtime-config.sh'),
);
const allowedWebRuntimeEnvironment = [
  'MOYA_DROPBOX_APP_KEY',
  'MOYA_DROPBOX_SOURCE_APP_KEY',
  'MOYA_GOOGLE_DRIVE_CLIENT_ID',
  'MOYA_GOOGLE_DRIVE_APP_ID',
  'MOYA_GOOGLE_DRIVE_DEVELOPER_KEY',
  'MOYA_SUWAYOMI_DEFAULT_URL',
];
const projectedWebRuntimeEnvironment = [...files.webRuntimeConfig.matchAll(/\$\{(MOYA_[A-Z0-9_]+):-/g)].map(
  (match) => match[1],
);
check(
  'web runtime config projects only the public environment allowlist',
  projectedWebRuntimeEnvironment.length === allowedWebRuntimeEnvironment.length &&
    new Set(projectedWebRuntimeEnvironment).size === allowedWebRuntimeEnvironment.length &&
    allowedWebRuntimeEnvironment.every((key) => projectedWebRuntimeEnvironment.includes(key)),
);
check(
  'web runtime config transports arbitrary identifier bytes without JavaScript interpolation',
  includes(files.webRuntimeConfig, 'printf \'%s\' "$1" | base64') && includes(files.webRuntimeConfig, "tr -d '\\r\\n'"),
);
check(
  'runtime config loads before the application module',
  files.indexHtml.indexOf('/runtime-config.js') >= 0 &&
    files.indexHtml.indexOf('/runtime-config.js') < files.indexHtml.indexOf('/src/main.tsx'),
);
check(
  'static runtime config is an empty versioned public stub',
  includes(files.publicRuntimeConfig, 'Object.freeze({ schemaVersion: 1 })'),
);

check(
  'server Dockerfile uses a Debian Bookworm build stage',
  includes(files.serverDockerfile, 'FROM node:22-bookworm-slim AS build'),
);
check(
  'server Dockerfile installs and copies shared workspaces',
  includes(files.serverDockerfile, 'COPY packages/contracts/package.json packages/contracts/package.json') &&
    includes(files.serverDockerfile, 'COPY packages/contracts packages/contracts') &&
    includes(
      files.serverDockerfile,
      'COPY packages/extension-contracts/package.json packages/extension-contracts/package.json',
    ) &&
    includes(files.serverDockerfile, 'COPY packages/extension-contracts packages/extension-contracts') &&
    includes(files.serverDockerfile, 'COPY packages/text-core/package.json packages/text-core/package.json') &&
    includes(files.serverDockerfile, 'COPY packages/text-core packages/text-core'),
);
check(
  'server Dockerfile builds and bundles server package',
  includes(files.serverDockerfile, 'pnpm --filter server build && pnpm --filter server bundle'),
);
check(
  'server Dockerfile deploys production dependencies only',
  includes(files.serverDockerfile, 'deploy --prod /opt/server'),
);
check(
  'server Dockerfile uses a Debian Bookworm runtime stage',
  includes(files.serverDockerfile, 'FROM node:22-bookworm-slim AS runtime'),
);
check('server Dockerfile exposes API port', includes(files.serverDockerfile, 'EXPOSE 8787'));
check(
  'server Dockerfile default command starts compiled server',
  includes(files.serverDockerfile, 'CMD ["node", "dist/index.js"]'),
);

check('local TTS override declares a model service', Boolean(localTTS));
check('local TTS stays off host ports', !matches(localTTS, /^ {4}ports:/m));
check('local TTS persists model downloads', includes(localTTS, 'local-tts-models:/models'));
check('local TTS exposes an internal healthcheck', includes(localTTS, 'http://127.0.0.1:9010/health'));
check(
  'local TTS connects API and worker by service name',
  (files.composeLocalTTS.match(/TTS_LOCAL_ENDPOINT_URL: http:\/\/tts-model:9010\/synthesize/g) ?? []).length === 2,
);
check(
  'local TTS override owns its default provider setting',
  (files.composeLocalTTS.match(/TTS_PROVIDER_DEFAULT: \$\{LOCAL_TTS_PROVIDER_DEFAULT:-local-endpoint\}/g) ?? [])
    .length === 2,
);
check(
  'local TTS override owns its enabled provider setting',
  (files.composeLocalTTS.match(/TTS_PROVIDER_ENABLED: \$\{LOCAL_TTS_PROVIDER_ENABLED:-local-endpoint\}/g) ?? [])
    .length === 2,
);
check(
  'local TTS allowlists only its service name',
  (files.composeLocalTTS.match(/LOCAL_TTS_ALLOWED_HOSTS: tts-model/g) ?? []).length === 2,
);
check(
  'local TTS remains an optional degraded dependency',
  !includes(files.composeLocalTTS, 'condition: service_healthy'),
);
for (const [name, guide] of [
  ['Korean Compose guide', files.composeGuideKo],
  ['technical Compose guide', files.composeDeployment],
]) {
  check(
    `${name} starts core before building optional TTS`,
    includes(guide, 'docker compose up -d --build') &&
      includes(guide, 'compose.local-tts.yaml build tts-model') &&
      includes(guide, 'compose.local-tts.yaml up -d --no-build'),
  );
  check(
    `${name} does not advertise a combined optional TTS build`,
    !includes(guide, 'compose.local-tts.yaml up -d --build'),
  );
}
check('local TTS Dockerfile pins MeloTTS source', includes(files.localTTSDockerfile, 'ARG MELOTTS_COMMIT='));
check('local TTS Dockerfile runs as non-root', includes(files.localTTSDockerfile, 'USER localtts'));
check('local TTS adapter implements voices', includes(files.localTTSServer, 'if self.path == "/voices"'));
check('local TTS adapter implements synthesis', includes(files.localTTSServer, 'if self.path != "/synthesize"'));

check('Suwayomi overlay declares the compatibility runtime', Boolean(suwayomi));
check(
  'Suwayomi overlay uses the official stable image by default',
  includes(suwayomi, 'ghcr.io/suwayomi/suwayomi-server:${SUWAYOMI_IMAGE_TAG:-stable}'),
);
check('Suwayomi is not published directly to a host port', !matches(suwayomi, /^ {4}ports:/m));
check('Suwayomi exposes only its Docker-network port', matches(suwayomi, /expose:\s*\n\s+- ['"]4567['"]/));
check(
  'Suwayomi requires explicit self-host credentials',
  includes(suwayomi, 'AUTH_USERNAME: ${SUWAYOMI_AUTH_USERNAME:?') &&
    includes(suwayomi, 'AUTH_PASSWORD: ${SUWAYOMI_AUTH_PASSWORD:?'),
);
check('Suwayomi defaults to UI login', includes(suwayomi, 'AUTH_MODE: ${SUWAYOMI_AUTH_MODE:-ui_login}'));
check(
  'Suwayomi persists data in its official data directory',
  includes(suwayomi, 'suwayomi-data:/home/suwayomi/.local/share/Tachidesk') &&
    includes(suwayomiVolumes, 'suwayomi-data:'),
);
check(
  'Suwayomi does not overwrite WebUI extension stores from environment',
  !includes(suwayomi, 'EXTENSION_STORES') && !includes(files.envExample, 'SUWAYOMI_EXTENSION_STORES='),
);
check(
  'Suwayomi healthcheck does not expose credentials and accepts auth boundaries',
  includes(suwayomi, 'curl --silent --output /dev/null --write-out') &&
    includes(suwayomi, 'test "$$status" = 401') &&
    includes(suwayomi, 'test "$$status" = 403') &&
    !includes(suwayomi, '--user') &&
    !includes(suwayomi, '$${AUTH_PASSWORD}'),
);
check(
  'Moya and Suwayomi share the configurable external NPM network',
  includes(suwayomiWeb, 'npm-proxy:') &&
    includes(suwayomiWeb, '${MOYA_PROXY_HOSTNAME:-moya-web}') &&
    includes(suwayomi, '${SUWAYOMI_PROXY_HOSTNAME:-moya-suwayomi}') &&
    includes(suwayomiNetworks, 'name: ${NPM_DOCKER_NETWORK:-npm_proxy}') &&
    includes(suwayomiNetworks, 'external: true'),
);
check(
  'NPM WireGuard guide documents the combined self-host path',
  includes(files.npmWireGuardGuide, 'compose.suwayomi.yaml') &&
    includes(files.npmWireGuardGuide, 'moya-web:80') &&
    includes(files.npmWireGuardGuide, 'moya-suwayomi:4567') &&
    includes(files.npmWireGuardGuide, 'MOYA_SUWAYOMI_DEFAULT_URL='),
);

check('public override forces external exposure', includes(files.composePublic, 'SERVER_EXPOSURE: external'));
check(
  'public override requires an auth token',
  includes(files.composePublic, 'READER_AUTH_TOKEN: ${READER_AUTH_TOKEN:?'),
);
check(
  'public override requires a PostgreSQL password for API and database',
  (files.composePublic.match(/POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:\?/g) ?? []).length >= 1 &&
    includes(files.composePublic, '${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD before public deployment}'),
);
check(
  'public override requires MinIO credentials',
  includes(files.composePublic, 'MINIO_ROOT_USER: ${MINIO_ROOT_USER:?') &&
    includes(files.composePublic, 'MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?'),
);
check(
  'public API storage credentials derive from the required MinIO credentials',
  includes(files.composePublic, 'S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER:?') &&
    includes(files.composePublic, 'S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:-${MINIO_ROOT_PASSWORD:?'),
);
check(
  'public override keeps same-origin CORS configuration optional',
  !includes(files.composePublic, 'CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:?'),
);
check(
  'public hosted E2E supplies isolated PostgreSQL credentials',
  includes(files.hostedE2E, "process.env.POSTGRES_PASSWORD = 'moya-e2e-postgres-password'"),
);
check(
  'public hosted E2E supplies isolated MinIO credentials',
  includes(files.hostedE2E, "process.env.MINIO_ROOT_USER = 'moya-e2e-storage'") &&
    includes(files.hostedE2E, "process.env.MINIO_ROOT_PASSWORD = 'moya-e2e-storage-password'"),
);
check('API installs graceful signal handlers', includes(files.serverIndex, "process.once('SIGTERM'"));
check('worker queue recovers stale imports', includes(files.serverQueue, 'recoverStaleImportJobs'));
check('API readiness includes worker heartbeat', includes(files.server, 'metrics.assertWorkerHeartbeatFresh()'));
check(
  'same-origin self-host browser traffic is accepted',
  includes(files.server, 'sameOriginHost(origin, request.headers.host)'),
);
check('stale upload cleanup runs periodically', includes(files.server, 'uploadPruneIntervalMs'));
check(
  'browser upload chunks use the documented 2 MiB resumable size',
  includes(files.serverUploadImport, 'DEFAULT_SERVER_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024'),
);

check('nginx proxies /api to api service', includes(files.nginx, 'proxy_pass http://api:8787/api/;'));
check('nginx proxies /health', includes(files.nginx, 'proxy_pass http://api:8787/health;'));
check('nginx proxies /ready', includes(files.nginx, 'proxy_pass http://api:8787/ready;'));
check('nginx serves SPA fallback', includes(files.nginx, 'try_files $uri $uri/ /index.html;'));
check('nginx gives backups a separate 512 MiB request boundary', includes(files.nginx, 'client_max_body_size 512m;'));
check('nginx streams backup request bodies upstream', includes(files.nginx, 'proxy_request_buffering off;'));
check(
  'nginx streams ordinary API uploads upstream',
  includes(blockAfter(files.nginx, '  location /api/ {'), 'proxy_request_buffering off;'),
);
check('nginx preserves an outer TLS proxy protocol', includes(files.nginx, '$moya_forwarded_proto'));
check(
  'nginx never caches container runtime config',
  includes(blockAfter(files.nginx, '  location = /runtime-config.js {'), 'Cache-Control "no-store, max-age=0"'),
);
check(
  'service worker bypasses container runtime config',
  includes(files.serviceWorker, "url.pathname === '/runtime-config.js'"),
);
check(
  'host nginx example proxies only to loopback web ingress',
  includes(files.hostNginxExample, 'proxy_pass http://127.0.0.1:8080;'),
);
check(
  'host nginx example permits ordinary upload chunks',
  includes(files.hostNginxExample, 'client_max_body_size 32m;'),
);
check(
  'host nginx example permits backup archives separately',
  includes(files.hostNginxExample, 'client_max_body_size 512m;'),
);
check(
  'host nginx example streams upload requests',
  includes(files.hostNginxExample, 'location ^~ /api/uploads/') &&
    includes(files.hostNginxExample, 'proxy_request_buffering off;'),
);
check(
  'nginx upload body limit is at least one configured chunk',
  (() => {
    const nginxMatch = files.nginx.match(/client_max_body_size\s+(\d+)m;/i);
    const chunkBytes = Number(envValue(files.envExample, 'MAX_CHUNK_BYTES') ?? 0);
    if (!nginxMatch || !Number.isFinite(chunkBytes)) return false;
    return Number(nginxMatch[1]) * 1024 * 1024 >= chunkBytes;
  })(),
);

for (const key of [
  'COMPOSE_PROJECT_NAME',
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'SERVER_EXPOSURE',
  'WEB_BIND_ADDRESS',
  'MINIO_CONSOLE_BIND_ADDRESS',
  'CORS_ALLOWED_ORIGINS',
  'LOCAL_TTS_ALLOWED_HOSTS',
  'PROVIDER_MAX_ACTIVE_ATTEMPTS',
  'PROVIDER_MAX_ATTEMPTS_PER_MINUTE',
  'PROVIDER_MAX_ATTEMPTS_PER_UTC_DAY',
  'IMPORT_RUNNING_STALE_MS',
  'VERTEX_CREDENTIALS_HOST_DIR',
  'LOCAL_TTS_PROVIDER_DEFAULT',
  'LOCAL_TTS_PROVIDER_ENABLED',
  'MELOTTS_COMMIT',
  'VITE_READER_BACKEND',
  'VITE_API_BASE_URL',
  'VITE_SYNC_API_BASE_URL',
  'MOYA_DROPBOX_APP_KEY',
  'MOYA_DROPBOX_SOURCE_APP_KEY',
  'MOYA_GOOGLE_DRIVE_CLIENT_ID',
  'MOYA_GOOGLE_DRIVE_APP_ID',
  'MOYA_GOOGLE_DRIVE_DEVELOPER_KEY',
  'MOYA_SUWAYOMI_DEFAULT_URL',
  'SUWAYOMI_AUTH_MODE',
  'SUWAYOMI_AUTH_USERNAME',
  'SUWAYOMI_AUTH_PASSWORD',
  'NPM_DOCKER_NETWORK',
]) {
  check(`.env.example includes ${key}`, files.envExample.includes(`${key}=`));
}
check(
  '.env.example defaults hosted web to remote backend',
  envValue(files.envExample, 'VITE_READER_BACKEND') === 'remote',
);
check('.env.example defaults API base to /api', envValue(files.envExample, 'VITE_API_BASE_URL') === '/api');
check(
  '.env.example defaults active provider attempts to 4',
  envValue(files.envExample, 'PROVIDER_MAX_ACTIVE_ATTEMPTS') === '4',
);
check(
  '.env.example defaults rolling provider attempts to 60',
  envValue(files.envExample, 'PROVIDER_MAX_ATTEMPTS_PER_MINUTE') === '60',
);
check(
  '.env.example defaults UTC-day provider attempts to 1000',
  envValue(files.envExample, 'PROVIDER_MAX_ATTEMPTS_PER_UTC_DAY') === '1000',
);

check(
  'server schema creates paragraph_search table',
  includes(files.serverSchema, 'create table if not exists paragraph_search'),
);
check(
  'server schema backfills paragraph_search from paragraph_pages',
  includes(files.serverSchema, 'cross join lateral jsonb_array_elements(pp.paragraphs) paragraph'),
);
check(
  'server schema gates paragraph_search backfill to empty table',
  includes(files.serverSchema, 'if not exists (select 1 from paragraph_search limit 1) then'),
);
check(
  'server schema backfills paragraph_search without restart rewrites',
  includes(files.serverSchema, 'on conflict (id) do nothing'),
);
check(
  'server schema enables pg_trgm for paragraph search',
  includes(files.serverSchema, 'create extension if not exists pg_trgm'),
);
check('server schema indexes paragraph_search text', includes(files.serverSchema, 'idx_paragraph_search_text_trgm'));
check(
  'server schema stores upload chapter split mode',
  includes(files.serverSchema, 'chapter_split_mode text not null default'),
);

check(
  'hosted live smoke verifies paragraph lookup',
  includes(files.liveSmoke, '/paragraphs/${encodeURIComponent(firstParagraph.id)}'),
);
check(
  'hosted live smoke verifies chapter search',
  includes(files.liveSmoke, '/chapters/${encodeURIComponent(firstChapter.id)}/search'),
);
check(
  'hosted live smoke verifies book search',
  includes(files.liveSmoke, '/books/${encodeURIComponent(importedBookId)}/search'),
);
check(
  'hosted live smoke uploads multiple chunks',
  [
    'const minimumUploadChunks = 3',
    'Math.ceil(sampleBytes.byteLength / minimumUploadChunks)',
    'const totalChunks = Math.max(1, Math.ceil(sampleBytes.byteLength / uploadChunkBytes))',
    'totalChunks,',
    'for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1)',
    '/chunks/${chunkIndex}',
  ].every((needle) => includes(files.liveSmoke, needle)),
);
check(
  'hosted live smoke verifies chunk status',
  [
    'const expectedChunkIndexes = Array.from({ length: totalChunks }',
    'uploadStatus.totalChunks === totalChunks',
    "uploadStatus.chapterSplitMode === 'mixed'",
    'uploadStatus.uploadedBytes === sampleBytes.byteLength',
    'arraysEqual(receivedChunkIndexes, expectedChunkIndexes)',
    'assert(missingChunkIndexes.length === 0',
    'assert(uploadStatus.complete === true',
  ].every((needle) => includes(files.liveSmoke, needle)),
);
check('hosted live smoke sends chapter split mode', includes(files.liveSmoke, "chapterSplitMode: 'mixed'"));
check(
  'package exposes hosted e2e command',
  includes(files.packageJson, '"check:hosted:e2e": "node scripts/hosted-e2e.mjs"'),
);
check(
  'package exposes hosted AI workflow e2e command',
  includes(files.packageJson, '"check:hosted:ai-workflow": "node scripts/hosted-e2e.mjs --include-ai-workflow"'),
);
check('hosted e2e runs static hosted verification', includes(files.hostedE2E, "run('pnpm', ['check:hosted'])"));
check(
  'hosted e2e validates compose config',
  includes(files.hostedE2E, "dockerComposeArgs(projectName, composeFiles, ['config', '--quiet'])"),
);
check(
  'hosted e2e starts compose stack',
  includes(files.hostedE2E, "'up'") && includes(files.hostedE2E, "...(skipBuild ? [] : ['--build'])"),
);
check('hosted e2e runs live smoke script', includes(files.hostedE2E, "'scripts/hosted-live-smoke.mjs'"));
check('hosted e2e supports the protected public override', includes(files.hostedE2E, "hasArg('--public')"));
check('hosted live smoke verifies the bearer boundary', includes(files.liveSmoke, 'verifyProtectedApiBoundary'));
check(
  'hosted live smoke verifies worker readiness',
  includes(files.liveSmoke, 'readiness worker heartbeat check failed'),
);
check('hosted live smoke waits for full readiness', includes(files.liveSmoke, 'waitForReadiness'));
check(
  'hosted e2e can include AI workflow smoke script',
  includes(files.hostedE2E, "'scripts/hosted-ai-workflow-smoke.mjs'") &&
    includes(files.hostedE2E, '--include-ai-workflow') &&
    includes(files.hostedE2E, '--browser-ui'),
);
check(
  'hosted e2e tears down volumes by default',
  includes(files.hostedE2E, "['down', ...(keepData ? [] : ['--volumes'])]"),
);
check('hosted e2e ignores pnpm argument separator', includes(files.hostedE2E, "filter((arg) => arg !== '--')"));
check('hosted e2e uses shell on Windows', includes(files.hostedE2E, "shell: process.platform === 'win32'"));

check(
  'hosted AI workflow smoke uses test_novel source by default',
  includes(files.aiWorkflowSmoke, "process.env.HOSTED_AI_WORKFLOW_SOURCE_DIR ?? 'test_novel'"),
);
check(
  'hosted AI workflow smoke uploads and imports TXT chunks',
  ['/uploads/init', '/chunks/${chunkIndex}', '/complete', 'waitForImport'].every((needle) =>
    includes(files.aiWorkflowSmoke, needle),
  ),
);
check(
  'hosted AI workflow smoke starts mock book workflow',
  ['/analysis-workflows', "providerId: 'mock'", "modelId: 'mock-segment-labeler-v1'", 'waitForWorkflow'].every(
    (needle) => includes(files.aiWorkflowSmoke, needle),
  ),
);
check(
  'hosted AI workflow smoke verifies graph labels and readiness',
  ['/character-graph', '/segments', 'ttsReadiness?.ok === true', '/tts-cache-readiness'].every((needle) =>
    includes(files.aiWorkflowSmoke, needle),
  ),
);
check(
  'hosted AI workflow smoke verifies AI/TTS sync events',
  ['voice_profiles_updated', 'character_graph_updated', 'chapter_segments_updated'].every((needle) =>
    includes(files.aiWorkflowSmoke, needle),
  ),
);
check(
  'hosted AI workflow smoke exercises alternate managed execution and basic TTS fallback',
  [
    'moya.ai.tts.book-preparation',
    'moya.ai.tts.detailed.speaker-preparation',
    'startWorkflowFromBrowser',
    'verifyCompletedWorkflowInBrowser',
    'alternate trusted runner applied its two-paragraph planning policy',
    'basic/system TTS play action was disabled beside the completed workflow',
  ].every((needle) => includes(files.aiWorkflowSmoke, needle)),
);

const failed = checks.filter((item) => !item.passed);
for (const item of checks) {
  const marker = item.passed ? 'ok' : 'fail';
  console.log(`${marker} ${item.name}${!item.passed && item.detail ? ` - ${item.detail}` : ''}`);
}

if (failed.length) {
  console.error(`\nHosted deploy verification failed: ${failed.length} check(s) failed.`);
  process.exit(1);
}

console.log(`\nHosted deploy verification passed: ${checks.length} checks.`);
