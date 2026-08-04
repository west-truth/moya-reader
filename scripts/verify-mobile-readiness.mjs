import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const strict = process.argv.includes('--strict');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

const files = {
  packageJson: read('package.json'),
  cargoToml: read('src-tauri/Cargo.toml'),
  tauriConfig: read('src-tauri/tauri.conf.json'),
  appRuntime: read('src/app/runtime/app-runtime.ts'),
  desktopProviderCatalog: read('src/providers/desktop-provider-catalog.ts'),
  runtime: exists('src/platform/runtime.ts') ? read('src/platform/runtime.ts') : '',
  runtimeTest: exists('src/test/platform-runtime.test.ts') ? read('src/test/platform-runtime.test.ts') : '',
  rustLib: read('src-tauri/src/lib.rs'),
  rustApp: read('src-tauri/src/app.rs'),
  rustProviderHttp: read('src-tauri/src/provider_http.rs'),
  rustProviderSecrets: read('src-tauri/src/provider_secrets.rs'),
  rustAiBridge: read('src-tauri/src/ai/bridge.rs'),
  rustAiProvider: read('src-tauri/src/ai/provider.rs'),
  rustTtsBridge: read('src-tauri/src/tts/bridge.rs'),
  rustTtsLocalEndpoint: read('src-tauri/src/tts/local_endpoint_provider.rs'),
  rustTtsRenderCache: read('src-tauri/src/tts/render_cache.rs'),
  rustTtsAndroidWorker: exists('src-tauri/src/tts/android_worker.rs')
    ? read('src-tauri/src/tts/android_worker.rs')
    : '',
  androidRecoveryWorker: exists('src-tauri/mobile/android/NativeTtsRecoveryWorker.kt.template')
    ? read('src-tauri/mobile/android/NativeTtsRecoveryWorker.kt.template')
    : '',
  tauriCapability: exists('src-tauri/capabilities/default.json') ? read('src-tauri/capabilities/default.json') : '',
  androidSecretPlugin: exists('src-tauri/mobile/android/ProviderSecretStorePlugin.kt')
    ? read('src-tauri/mobile/android/ProviderSecretStorePlugin.kt')
    : '',
  androidSecretStore: exists('src-tauri/mobile/android/ProviderSecretStore.kt.template')
    ? read('src-tauri/mobile/android/ProviderSecretStore.kt.template')
    : '',
  androidSecretPluginSync: exists('scripts/sync-tauri-android-provider-secret-plugin.mjs')
    ? read('scripts/sync-tauri-android-provider-secret-plugin.mjs')
    : '',
};
const rustAll = [
  files.rustLib,
  files.rustApp,
  files.rustProviderHttp,
  files.rustProviderSecrets,
  files.rustAiBridge,
  files.rustAiProvider,
  files.rustTtsBridge,
  files.rustTtsLocalEndpoint,
].join('\n');
const tauriConfigJson = JSON.parse(files.tauriConfig);
const androidIdentifier = String(tauriConfigJson.identifier ?? '').trim();
const androidPluginPackage = `${androidIdentifier}.plugins`;
const androidIdentifierValid = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(androidIdentifier);

const checks = [];

function check(name, passed, detail, requiredForApk = true) {
  checks.push({ name, passed, detail, requiredForApk });
}

function includes(file, needle) {
  return file.includes(needle);
}

function hasProviderExecutionRuntimeExpectation(file, { platformKind, hasSyncApiClient, expectedRuntime }) {
  const expectationPattern =
    /expect\s*\(\s*resolveProviderExecutionRuntime\s*\(\s*\{([^{}]*)\}\s*\)\s*,?\s*\)\s*\.\s*toBe\s*\(\s*['"](server|desktop|none)['"]\s*\)/g;

  for (const match of file.matchAll(expectationPattern)) {
    const [, input, runtime] = match;
    const platformPattern = new RegExp(`\\bplatformKind\\s*:\\s*['"]${platformKind}['"]`);
    const syncClientPattern = new RegExp(`\\bhasSyncApiClient\\s*:\\s*${hasSyncApiClient}\\b`);

    if (platformPattern.test(input) && syncClientPattern.test(input) && runtime === expectedRuntime) {
      return true;
    }
  }

  return false;
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function hasAndroidRustTarget() {
  return commandOutput('rustup', ['target', 'list', '--installed'])
    .split(/\r?\n/)
    .some((line) => line.trim() === 'aarch64-linux-android');
}

function hasAndroidNdkClang(ndkRoot) {
  if (!ndkRoot || !fs.existsSync(ndkRoot)) return false;
  const prebuiltRoot = path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt');
  if (!fs.existsSync(prebuiltRoot)) return false;
  for (const hostDir of fs.readdirSync(prebuiltRoot)) {
    const binDir = path.join(prebuiltRoot, hostDir, 'bin');
    if (!fs.existsSync(binDir)) continue;
    const names = new Set(fs.readdirSync(binDir));
    for (const suffix of ['', '.cmd', '.exe']) {
      if (names.has(`aarch64-linux-android-clang${suffix}`)) return true;
    }
    for (const name of names) {
      if (/^aarch64-linux-android\d+-clang(\.cmd|\.exe)?$/.test(name)) return true;
    }
  }
  return false;
}

function findNdkRoots(androidSdkRoot, explicitNdkRoot) {
  const roots = [];
  if (explicitNdkRoot) roots.push(explicitNdkRoot);
  const sdkNdkRoot = androidSdkRoot ? path.join(androidSdkRoot, 'ndk') : '';
  if (sdkNdkRoot && fs.existsSync(sdkNdkRoot)) {
    for (const versionDir of fs.readdirSync(sdkNdkRoot)) {
      roots.push(path.join(sdkNdkRoot, versionDir));
    }
  }
  return roots;
}

function findAndroidSdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.env.HOME && process.platform === 'darwin' && path.join(process.env.HOME, 'Library', 'Android', 'sdk'),
    process.env.HOME && process.platform !== 'darwin' && path.join(process.env.HOME, 'Android', 'Sdk'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? '';
}

function functionBlock(file, signature) {
  const start = file.indexOf(signature);
  if (start < 0) return '';
  const braceStart = file.indexOf('{', start);
  if (braceStart < 0) return '';
  let depth = 0;
  for (let index = braceStart; index < file.length; index += 1) {
    const char = file[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return file.slice(start, index + 1);
    }
  }
  return file.slice(start);
}

const desktopAiGenerateJsonBlock = functionBlock(files.rustAiBridge, 'async fn desktop_ai_generate_json_impl');
const desktopTtsListVoicesBlock = functionBlock(files.rustTtsBridge, 'async fn desktop_tts_list_voices_impl');
const providerSecretStatusBlock = functionBlock(files.rustProviderSecrets, 'struct ProviderSecretStatus');
const androidSdkRoot = findAndroidSdkRoot();
const androidNdkRoot = process.env.NDK_HOME || process.env.ANDROID_NDK_HOME || '';
const androidNdkRoots = findNdkRoots(androidSdkRoot, androidNdkRoot);
const androidNdkPresent = androidNdkRoots.some((rootPath) => fs.existsSync(rootPath));
const androidNdkClangPresent = androidNdkRoots.some(hasAndroidNdkClang);

check('Tauri 모바일 진입점 존재', includes(files.rustApp, '#[cfg_attr(mobile, tauri::mobile_entry_point)]'));
check(
  'Rust composition root가 app/secret/http/AI/TTS 모듈만 조립',
  includes(files.rustLib, 'mod app;') &&
    includes(files.rustLib, 'mod provider_http;') &&
    includes(files.rustLib, 'mod provider_secrets;') &&
    includes(files.rustLib, 'mod ai;') &&
    includes(files.rustLib, 'mod tts;') &&
    includes(files.rustLib, 'pub use app::run;'),
  'src-tauri/src/lib.rs는 네이티브 모듈 조립점으로만 유지해야 함',
  false,
);
check(
  'JS command 경계에 provider secret read-back 명령 없음',
  includes(files.rustApp, 'provider_secret_set') &&
    includes(files.rustApp, 'provider_secret_status') &&
    includes(files.rustApp, 'provider_secret_delete') &&
    includes(files.rustApp, 'provider_secret_test') &&
    !includes(files.rustApp, 'provider_secret_get') &&
    !includes(providerSecretStatusBlock, 'secret_value') &&
    !includes(providerSecretStatusBlock, 'secretValue'),
  'JS에는 set/status/delete/test와 파생 status만 노출하고 secret 원문 getter를 등록하면 안 됨',
);
check('Android 프로젝트 초기화 완료', exists('src-tauri/gen/android'), 'src-tauri/gen/android 없음');
check(
  'Android SDK 경로 설정',
  Boolean(androidSdkRoot && fs.existsSync(androidSdkRoot)),
  'ANDROID_HOME 또는 ANDROID_SDK_ROOT가 유효하지 않음',
);
check('Android NDK 경로 설정', androidNdkPresent, 'NDK_HOME/ANDROID_NDK_HOME 또는 ANDROID_HOME/ndk가 유효하지 않음');
check('Android Rust target 설치', hasAndroidRustTarget(), 'rustup target add aarch64-linux-android 필요');
check('Android NDK clang toolchain 사용 가능', androidNdkClangPresent, 'aarch64-linux-android-clang을 찾을 수 없음');
check(
  'package Android init 스크립트 존재',
  includes(files.packageJson, '"tauri:android:init"'),
  'tauri:android:init 스크립트 없음',
);
check(
  'package Android dev 스크립트 존재',
  includes(files.packageJson, '"tauri:android:dev"'),
  'tauri:android:dev 스크립트 없음',
);
check(
  'package Android APK build 스크립트 존재',
  includes(files.packageJson, '"tauri:android:build"'),
  'tauri:android:build 스크립트 없음',
);
check(
  'Android provider plugin 동기화 스크립트 연결',
  includes(files.packageJson, 'tauri:android:sync-provider-plugin') &&
    includes(files.packageJson, 'sync-tauri-android-provider-secret-plugin.mjs') &&
    includes(files.androidSecretPluginSync, 'ProviderSecretStorePlugin.kt') &&
    includes(files.androidSecretPluginSync, 'src-tauri/gen/android') &&
    includes(files.androidSecretPluginSync, 'tauri.conf.json') &&
    includes(files.androidSecretPluginSync, 'identifier') &&
    includes(files.androidSecretPluginSync, 'pluginPackage.split'),
  'Android Gradle 프로젝트로 provider secret plugin을 복사하는 스크립트가 없음',
);
check(
  'Android provider plugin package/registration 일치',
  androidIdentifierValid &&
    includes(files.androidSecretPlugin, `package ${androidPluginPackage}`) &&
    includes(files.rustProviderSecrets, `"${androidPluginPackage}"`) &&
    includes(files.androidSecretPluginSync, 'pluginPackage') &&
    includes(files.androidSecretPluginSync, 'packageMatch'),
  `Android plugin package, Rust register_android_plugin package, sync target이 ${androidPluginPackage} 기준으로 맞아야 함`,
);
check('데스크톱 번들 대상 NSIS 유지', includes(files.tauriConfig, '"targets": ["nsis"]'), undefined, false);
check(
  '데스크톱 provider keyring native backend 명시',
  includes(files.cargoToml, 'windows-native') &&
    includes(files.cargoToml, 'apple-native') &&
    includes(files.cargoToml, 'linux-native-sync-persistent'),
  'keyring platform feature가 없으면 mock credential store로 떨어질 수 있음',
  false,
);
check(
  '플랫폼 런타임 감지 분리 존재',
  includes(files.runtime, 'tauri-mobile') && includes(files.runtime, 'tauri-desktop'),
  'tauri-mobile/tauri-desktop 런타임 분리 없음',
  false,
);
check(
  '앱이 서버 provider 클라이언트를 우선하고 데스크톱 provider 클라이언트를 분리',
  includes(files.appRuntime, 'resolveProviderExecutionRuntime') &&
    includes(files.appRuntime, "providerExecutionRuntime === 'server'") &&
    includes(files.appRuntime, "providerExecutionRuntime === 'desktop'") &&
    includes(files.appRuntime, 'new DesktopProviderControlClient()'),
  '서버 provider 클라이언트와 데스크톱 provider 실행 경로 분리 확인 필요',
  false,
);
check(
  '플랫폼 런타임 테스트가 Android Tauri WebView 포함',
  includes(files.runtimeTest, 'Android Tauri WebView') && includes(files.runtimeTest, 'tauri-mobile'),
  'Android Tauri 런타임 테스트 없음',
  false,
);
check(
  'APK 연결형 provider 실행 경로 구현',
  hasProviderExecutionRuntimeExpectation(files.runtimeTest, {
    platformKind: 'tauri-mobile',
    hasSyncApiClient: true,
    expectedRuntime: 'server',
  }),
  'tauri-mobile이 서버 연결 시 provider 실행 경로를 server로 선택하는 테스트 없음',
);
check(
  'APK 직접 provider 실행 경로 구현',
  hasProviderExecutionRuntimeExpectation(files.runtimeTest, {
    platformKind: 'tauri-mobile',
    hasSyncApiClient: false,
    expectedRuntime: 'desktop',
  }),
  'tauri-mobile이 서버 없이 Android secure-store provider 실행 경로를 선택하는 테스트 없음',
);
check(
  '데스크톱 AI providerOptions의 secret-like 값 거부',
  includes(desktopAiGenerateJsonBlock, 'ensure_non_secret_provider_options(&request.provider_options)?;'),
  'desktop_ai_generate_json에서 secret-like providerOptions 거부 필요',
  false,
);
check(
  '네이티브 Gemini API key URL query 미사용',
  includes(files.rustAiProvider, 'fn gemini_ai_studio_generate_content_url') &&
    includes(files.rustAiProvider, 'fn gemini_ai_studio_headers') &&
    includes(files.rustAiProvider, '"x-goog-api-key"') &&
    !includes(desktopAiGenerateJsonBlock, ':generateContent?key='),
  'Gemini AI Studio native 호출은 API key를 URL query가 아니라 header로 보내야 함',
  false,
);
check(
  '네이티브 provider HTTP timeout 적용',
  includes(files.rustProviderHttp, 'NATIVE_AI_REQUEST_TIMEOUT_SECS') &&
    includes(files.rustProviderHttp, 'NATIVE_TTS_REQUEST_TIMEOUT_SECS') &&
    includes(files.rustProviderHttp, 'NATIVE_TTS_VOICE_DISCOVERY_TIMEOUT_SECS') &&
    includes(files.rustProviderHttp, 'fn native_provider_http_client') &&
    !includes(rustAll, 'reqwest::Client::new()'),
  'native provider 요청은 timeout이 있는 reqwest client를 사용해야 함',
  false,
);
check(
  '네이티브 TTS providerOptions의 secret-like 값 거부',
  includes(files.rustTtsBridge, 'ensure_non_secret_provider_options(&request.provider_options)?;'),
  'desktop_tts_synthesize에서 secret-like providerOptions 거부 필요',
  false,
);
check(
  'Android 직접 보안 저장소 adapter 구현',
  includes(files.rustProviderSecrets, 'AndroidProviderSecretStore') &&
    includes(files.rustProviderSecrets, 'register_android_plugin') &&
    includes(files.rustProviderSecrets, 'stored_secret_for_app') &&
    includes(files.rustProviderSecrets, 'android_secure_store') &&
    includes(files.androidSecretStore, 'AndroidKeyStore') &&
    includes(files.androidSecretStore, 'AES/GCM/NoPadding') &&
    includes(files.androidSecretPlugin, 'setSecret') &&
    includes(files.androidSecretPlugin, 'getSecret'),
  'Android 기기 로컬 provider key 저장용 Keystore adapter 없음',
);
check(
  'Android provider plugin 직접 JS 권한 차단',
  !includes(files.tauriCapability, 'providerSecretStore') && !includes(files.tauriCapability, 'getSecret'),
  'capability에 providerSecretStore/getSecret 권한을 추가하면 JS가 native plugin을 직접 호출할 수 있음',
);
check(
  'Android 로컬 Vertex credential_path 차단',
  includes(files.rustProviderSecrets, 'Android local mode does not support credential_path secrets yet') &&
    includes(
      desktopAiGenerateJsonBlock,
      'Android local mode does not support gemini-vertex credential_path execution yet',
    ) &&
    includes(files.desktopProviderCatalog, "nativePlatformKind === 'tauri-mobile'") &&
    includes(files.desktopProviderCatalog, "return ['openai', 'gemini-ai-studio', 'anthropic']"),
  'Android local direct mode에서는 파일 경로 기반 Vertex credential_path를 노출하지 않아야 함',
);
check(
  'Android/desktop 로컬 endpoint TTS 경계 구현',
  includes(files.desktopProviderCatalog, "providerId === 'local-endpoint'") &&
    includes(files.desktopProviderCatalog, "if (providerId === 'local-endpoint') return 'endpoint_url'") &&
    includes(files.desktopProviderCatalog, 'Local TTS Endpoint') &&
    includes(files.rustProviderHttp, 'validate_local_endpoint_url') &&
    includes(files.rustProviderSecrets, 'secret_name == "endpoint_url"') &&
    includes(files.rustTtsBridge, 'provider_id == "local-endpoint"') &&
    includes(files.rustTtsBridge, '"local-endpoint" => ("local-endpoint", "endpoint_url")') &&
    includes(desktopTtsListVoicesBlock, 'provider_id == "local-endpoint"') &&
    includes(files.rustTtsLocalEndpoint, 'local_endpoint_voices_url'),
  'local-endpoint TTS는 catalog, endpoint_url secure-store, synthesize, voice discovery 경계가 모두 필요함',
);
check(
  'Android에서 데스크톱 keyring을 보안 저장소로 쓰지 않음',
  includes(files.rustProviderSecrets, '#[cfg(not(target_os = "android"))]') &&
    !/target_os\s*=\s*"android"[^[]*\.dependencies\][\s\S]*?\bkeyring\s*=/m.test(files.cargoToml),
  'Android는 데스크톱 keyring 대신 전용 secure-store branch가 필요',
);
check(
  'Android native TTS WorkManager 복구 경계 구현',
  includes(files.androidRecoveryWorker, 'WorkManager') &&
    includes(files.androidRecoveryWorker, 'NetworkType.CONNECTED') &&
    includes(files.androidRecoveryWorker, 'NetworkType.UNMETERED') &&
    includes(files.androidRecoveryWorker, 'setRequiresCharging') &&
    includes(files.androidRecoveryWorker, 'matchesPolicy') &&
    includes(files.androidRecoveryWorker, 'setRequiresBatteryNotLow(true)') &&
    includes(files.androidRecoveryWorker, 'setRequiresStorageNotLow(true)') &&
    includes(files.androidRecoveryWorker, 'ProviderSecretStore.get') &&
    includes(files.rustTtsAndroidWorker, 'render_cached_with') &&
    includes(files.rustTtsAndroidWorker, 'desktop_tts_synthesize_with_secret') &&
    includes(files.rustTtsRenderCache, 'should_persist_pending') &&
    includes(files.rustTtsRenderCache, 'android_recovery::schedule') &&
    includes(files.androidSecretPluginSync, 'NativeTtsRecoveryWorker.kt.template') &&
    includes(files.androidSecretPluginSync, 'work-runtime-ktx:2.10.1'),
  'native pending manifest를 constrained WorkManager에서 Keystore -> Rust provider/cache 경계로 재개해야 함',
);

const blocking = checks.filter((item) => item.requiredForApk && !item.passed);
for (const item of checks) {
  const marker = item.passed ? '[통과]' : item.requiredForApk ? '[APK 차단]' : '[주의]';
  console.log(`${marker} ${item.name}${!item.passed && item.detail ? ` - ${item.detail}` : ''}`);
}

if (blocking.length) {
  console.log(`\nAPK 준비 상태: 미완료 (${blocking.length}개 차단 항목).`);
  console.log('이 결과는 데스크톱/웹 앱 오류가 아니라, APK 빌드 전에 남은 작업을 보여주는 상태 리포트입니다.');
  if (strict) process.exit(1);
  console.log('CI에서 APK 준비 미완료를 실패로 처리하려면 pnpm check:mobile-readiness:strict를 사용하세요.');
} else {
  console.log('\nAPK 준비 상태: 통과.');
}
