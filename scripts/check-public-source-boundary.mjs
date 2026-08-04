import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
  .map((file) => file.replaceAll('\\', '/'));
const trackedSet = new Set(tracked);

const forbiddenPrefixes = [
  '.noveldesk-lab/',
  'artifacts/',
  'handoff/',
  'smart-novel-reader-codex-pack/',
  'speaker-review-studio/',
  'test_novel/',
  'ui-reference/',
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

const forbiddenNames = new Set(['google-services.json', 'key.properties', 'keystore.properties', 'local.properties']);
const forbiddenExtensions = new Set([
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

const violations = tracked.filter((file) => {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  return (
    forbiddenPrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase())) ||
    forbiddenNames.has(base) ||
    forbiddenExtensions.has(path.posix.extname(lower)) ||
    /(^|\/)(credentials[^/]*|[^/]*service-account[^/]*)\.json$/i.test(file) ||
    /^scripts\/test-novel-.*\.ts$/i.test(file) ||
    (lower.startsWith('secrets/') && lower !== 'secrets/vertex/.gitkeep')
  );
});

const requiredProductSources = [
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
  'scripts/sync-tauri-android-document-io-plugin.mjs',
  'scripts/sync-tauri-android-provider-secret-plugin.mjs',
  'scripts/verify-mobile-readiness.mjs',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];
const missing = requiredProductSources.filter((file) => !trackedSet.has(file));

if (violations.length > 0 || missing.length > 0) {
  if (violations.length > 0) {
    console.error('공개 저장소에 금지된 추적 파일이 있습니다:');
    for (const file of violations) console.error(`- ${file}`);
  }
  if (missing.length > 0) {
    console.error('전체 제품 소스에 필요한 파일이 누락됐습니다:');
    for (const file of missing) console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log(`공개 소스 경계 통과: tracked=${tracked.length}, native-required=${requiredProductSources.length}`);
