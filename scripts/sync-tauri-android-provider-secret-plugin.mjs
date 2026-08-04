import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const pluginFiles = ['ProviderSecretStorePlugin.kt', 'AppCredentialStorePlugin.kt', 'DocumentIoPlugin.kt'];
const templateFiles = [
  {
    source: 'MainActivity.kt.template',
    packageName: (identifier) => identifier,
    target: (identifier) => path.join('app/src/main/java', ...identifier.split('.'), 'MainActivity.kt'),
  },
  {
    source: 'NovelDeskPlaybackService.kt.template',
    packageName: (identifier) => identifier,
    target: (identifier) => path.join('app/src/main/java', ...identifier.split('.'), 'NovelDeskPlaybackService.kt'),
  },
  ...['ProviderSecretStore.kt.template', 'NativeTtsRecoveryWorker.kt.template'].map((source) => ({
    source,
    packageName: (identifier) => identifier,
    target: (identifier) => path.join('app/src/main/java', ...identifier.split('.'), source.replace(/\.template$/, '')),
  })),
  {
    source: 'NativeTtsRecoveryPlugin.kt.template',
    packageName: (identifier) => `${identifier}.plugins`,
    target: (identifier) =>
      path.join('app/src/main/java', ...`${identifier}.plugins`.split('.'), 'NativeTtsRecoveryPlugin.kt'),
  },
  ...['AndroidShellPlugin.kt.template', 'SystemTtsPlugin.kt.template'].map((source) => ({
    source,
    packageName: (identifier) => `${identifier}.plugins`,
    target: (identifier) =>
      path.join('app/src/main/java', ...`${identifier}.plugins`.split('.'), source.replace(/\.template$/, '')),
  })),
];
const tauriConfigPath = path.join(root, 'src-tauri/tauri.conf.json');
const androidProject = path.join(root, 'src-tauri/gen/android');
const androidIconSource = path.join(root, 'src-tauri/icons/android');
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
const identifier = String(tauriConfig.identifier ?? '').trim();
if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(identifier)) {
  console.error('[APK 차단] src-tauri/tauri.conf.json identifier가 Android package로 사용할 수 없습니다.');
  process.exit(1);
}
const pluginPackage = `${identifier}.plugins`;
if (!fs.existsSync(androidProject)) {
  console.error('[APK 차단] src-tauri/gen/android가 없습니다. 먼저 pnpm tauri:android:init을 실행하세요.');
  process.exit(1);
}

for (const pluginFile of pluginFiles) {
  const source = path.join(root, 'src-tauri/mobile/android', pluginFile);
  const target = path.join(androidProject, 'app/src/main/java', ...pluginPackage.split('.'), pluginFile);
  if (!fs.existsSync(source)) {
    console.error(`[APK 차단] Android native plugin 원본이 없습니다: ${pluginFile}`);
    process.exit(1);
  }

  const sourceText = fs.readFileSync(source, 'utf8');
  const packageMatch = sourceText.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*$/m);
  if (packageMatch?.[1] !== pluginPackage) {
    console.error(
      `[APK 차단] Android native plugin package가 앱 identifier와 다릅니다. file=${pluginFile} expected=${pluginPackage}`,
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`[통과] Android native plugin 동기화: ${path.relative(root, target)}`);
}

for (const templateFile of templateFiles) {
  const source = path.join(root, 'src-tauri/mobile/android', templateFile.source);
  if (!fs.existsSync(source)) {
    console.error(`[APK 차단] Android native template가 없습니다: ${templateFile.source}`);
    process.exit(1);
  }

  const packageName = templateFile.packageName(identifier);
  const sourceText = fs
    .readFileSync(source, 'utf8')
    .replaceAll('__NOVELDESK_ANDROID_PACKAGE__', identifier)
    .replaceAll('__NOVELDESK_ANDROID_PLUGIN_PACKAGE__', pluginPackage);
  if (!sourceText.includes(`package ${packageName}`)) {
    console.error(`[APK 차단] Android native template package 치환에 실패했습니다: ${templateFile.source}`);
    process.exit(1);
  }

  const target = path.join(androidProject, templateFile.target(identifier));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, sourceText);
  console.log(`[통과] Android native template 동기화: ${path.relative(root, target)}`);
}

if (!fs.existsSync(androidIconSource)) {
  console.error('[APK 차단] Android launcher icon 원본이 없습니다: src-tauri/icons/android');
  process.exit(1);
}
const androidResourceTarget = path.join(androidProject, 'app/src/main/res');
fs.cpSync(androidIconSource, androidResourceTarget, { recursive: true, force: true });
console.log(`[통과] Android launcher icon 동기화: ${path.relative(root, androidResourceTarget)}`);

const androidBuildFile = path.join(androidProject, 'app/build.gradle.kts');
let androidBuild = fs.readFileSync(androidBuildFile, 'utf8');
for (const dependency of [
  'implementation("androidx.media3:media3-exoplayer:1.10.1")',
  'implementation("androidx.media3:media3-session:1.10.1")',
  'implementation("androidx.work:work-runtime-ktx:2.10.1")',
]) {
  if (!androidBuild.includes(dependency)) {
    androidBuild = androidBuild.replace(/dependencies\s*\{/, (match) => `${match}\n    ${dependency}`);
  }
}
fs.writeFileSync(androidBuildFile, androidBuild);

const androidManifestFile = path.join(androidProject, 'app/src/main/AndroidManifest.xml');
let androidManifest = fs.readFileSync(androidManifestFile, 'utf8');
for (const permission of [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
]) {
  if (!androidManifest.includes(permission)) {
    androidManifest = androidManifest.replace(
      '<uses-permission android:name="android.permission.INTERNET" />',
      `<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="${permission}" />`,
    );
  }
}
if (!androidManifest.includes('android:name=".NovelDeskPlaybackService"')) {
  androidManifest = androidManifest.replace(
    '    </application>',
    `        <service\n            android:name=".NovelDeskPlaybackService"\n            android:foregroundServiceType="mediaPlayback"\n            android:exported="true">\n            <intent-filter>\n                <action android:name="androidx.media3.session.MediaSessionService" />\n                <action android:name="android.media.browse.MediaBrowserService" />\n            </intent-filter>\n        </service>\n    </application>`,
  );
}
fs.writeFileSync(androidManifestFile, androidManifest);
console.log('[통과] Android Media3 background playback manifest/dependencies');
