import path from 'node:path';

export const PUBLIC_FORBIDDEN_PREFIXES = [
  '.noveldesk-lab/',
  'artifacts/',
  'handoff/',
  'smart-novel-reader-codex-pack/',
  'speaker-review-studio/',
  'test_novel/',
  'ui-reference/',
  'scripts/public-release-sync',
  'scripts/speaker-labeling-lab/',
  'scripts/speaker-pilot/',
  'docs/0722_review/',
  'docs/pro_review/',
  'docs/pro_review0713/',
  'docs/project/',
  'docs/refactoring/',
  'docs/design/ui-redesign-reference/',
  'docs/design/ui-redesign-prototype/',
  'docs/design/ui-redesign-references/',
  'src-tauri/target/',
];

export const PUBLIC_FORBIDDEN_NAMES = new Set([
  '.env',
  'google-services.json',
  'id_ed25519',
  'id_rsa',
  'key.properties',
  'keystore.properties',
  'local.properties',
]);

export const PUBLIC_FORBIDDEN_EXTENSIONS = new Set([
  '.aab',
  '.apk',
  '.appimage',
  '.deb',
  '.dmg',
  '.exe',
  '.ipa',
  '.jks',
  '.key',
  '.keystore',
  '.mobileprovision',
  '.msi',
  '.msix',
  '.p12',
  '.pem',
  '.pfx',
  '.pkg',
  '.rpm',
]);

export const PUBLIC_REQUIRED_PRODUCT_SOURCES = [
  'compose.metadata-collector.yaml',
  'compose.metadata-collector-auth.yaml',
  'deploy/metadata-collector.Dockerfile',
  'deploy/metadata-collector-auth.Dockerfile',
  'assets/branding/moya-app-icon.png',
  'assets/branding/moya-wordmark.png',
  'assets/branding/README.md',
  'public/manifest.webmanifest',
  'public/sw.js',
  'public/branding/moya-wordmark.png',
  'public/icons/moya-32.png',
  'public/icons/moya-192.png',
  'public/icons/moya-512.png',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/src/app.rs',
  'src-tauri/src/android_document_io.rs',
  'src-tauri/src/android_plugins.rs',
  'src-tauri/src/provider_secrets.rs',
  'src-tauri/src/secure_credentials.rs',
  'src-tauri/src/ai/bridge.rs',
  'src-tauri/src/tts/bridge.rs',
  'src-tauri/src/tts/render_cache.rs',
  'src-tauri/src/workflow/bridge.rs',
  'src-tauri/mobile/android/AppCredentialStorePlugin.kt',
  'src-tauri/mobile/android/DocumentIoPlugin.kt',
  'src-tauri/mobile/android/NativeTtsRecoveryWorker.kt.template',
  'src-tauri/mobile/android/NovelDeskPlaybackService.kt.template',
  'src-tauri/mobile/android/ProviderSecretStorePlugin.kt',
  'src-tauri/mobile/android/SystemTtsPlugin.kt.template',
  'src-tauri/gen/android/gradlew',
  'src-tauri/gen/android/app/build.gradle.kts',
  'src-tauri/gen/android/gradle/wrapper/gradle-wrapper.jar',
  'src-tauri/gen/android/app/src/main/AndroidManifest.xml',
  'scripts/build-android-arm64-debug.mjs',
  'scripts/build-webnovel-metadata-collector-sidecar.mjs',
  'scripts/generate-brand-assets.mjs',
  'scripts/generate-webnovel-metadata-collector-license-inventory.py',
  'scripts/public-release-boundary.mjs',
  'scripts/sync-tauri-android-document-io-plugin.mjs',
  'scripts/sync-tauri-android-provider-secret-plugin.mjs',
  'scripts/verify-mobile-readiness.mjs',
  'services/webnovel-metadata-collector/pyproject.toml',
  'services/webnovel-metadata-collector/app/sidecar.py',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];

export function normalizePublicPath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isForbiddenPublicPath(file) {
  const normalized = normalizePublicPath(file);
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  const extension = path.posix.extname(lower);

  return (
    PUBLIC_FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase())) ||
    PUBLIC_FORBIDDEN_NAMES.has(base) ||
    PUBLIC_FORBIDDEN_EXTENSIONS.has(extension) ||
    (base.startsWith('.env.') && base !== '.env.example') ||
    /(^|\/)(credentials[^/]*|[^/]*service-account[^/]*)\.json$/i.test(normalized) ||
    /^scripts\/test-novel-.*\.ts$/i.test(normalized) ||
    (lower.startsWith('secrets/') && lower !== 'secrets/vertex/.gitkeep')
  );
}

export function validatePublicFileList(files, requiredFiles = PUBLIC_REQUIRED_PRODUCT_SOURCES) {
  const normalized = files.map(normalizePublicPath);
  const fileSet = new Set(normalized);
  return {
    violations: normalized.filter(isForbiddenPublicPath),
    missing: requiredFiles.map(normalizePublicPath).filter((file) => !fileSet.has(file)),
  };
}
