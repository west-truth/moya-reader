import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tauriDir = path.join(root, 'src-tauri');
const androidDir = path.join(tauriDir, 'gen', 'android');
const appDir = path.join(androidDir, 'app');
const tauriConfigPath = path.join(tauriDir, 'tauri.conf.json');
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
const identifier = String(tauriConfig.identifier ?? '').trim();
const rustLibrary = 'noveldesk_reader_lib';
const requestedTarget =
  process.argv.find((argument) => argument.startsWith('--target='))?.slice('--target='.length) ?? 'arm64';
const targetConfig = {
  arm64: {
    rustTriple: 'aarch64-linux-android',
    compilerPrefix: 'aarch64-linux-android',
    cargoEnvironmentSuffix: 'aarch64_linux_android',
    abi: 'arm64-v8a',
    gradleFlavor: 'Arm64',
  },
  x86_64: {
    rustTriple: 'x86_64-linux-android',
    compilerPrefix: 'x86_64-linux-android',
    cargoEnvironmentSuffix: 'x86_64_linux_android',
    abi: 'x86_64',
    gradleFlavor: 'X86_64',
  },
}[requestedTarget];

function fail(message) {
  console.error(`[APK 차단] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) fail(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function findNdk(sdkRoot) {
  const candidates = [process.env.NDK_HOME, process.env.ANDROID_NDK_HOME].filter(Boolean);
  const sideBySide = path.join(sdkRoot, 'ndk');
  if (fs.existsSync(sideBySide)) {
    candidates.push(
      ...fs
        .readdirSync(sideBySide, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(sideBySide, entry.name))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true })),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function findJavaHome() {
  const candidates = [
    process.env.JAVA_HOME,
    process.platform === 'win32' ? 'C:\\Program Files\\Java\\jdk-21' : undefined,
  ].filter(Boolean);
  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')),
  );
}

function androidCargoEnvironment(sdkRoot, ndkRoot, javaHome) {
  const host =
    process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
  const bin = path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', host, 'bin');
  const commandSuffix = process.platform === 'win32' ? '.cmd' : '';
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const cc = path.join(bin, `${targetConfig.compilerPrefix}24-clang${commandSuffix}`);
  const cxx = path.join(bin, `${targetConfig.compilerPrefix}24-clang++${commandSuffix}`);
  const ar = path.join(bin, `llvm-ar${executableSuffix}`);
  for (const tool of [cc, cxx, ar]) {
    if (!fs.existsSync(tool)) fail(`Android NDK tool을 찾을 수 없습니다: ${tool}`);
  }

  const packageSourceDir = path.join(appDir, 'src', 'main', 'java', ...identifier.split('.'));
  return {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    NDK_HOME: ndkRoot,
    [`CC_${targetConfig.cargoEnvironmentSuffix}`]: cc,
    [`CXX_${targetConfig.cargoEnvironmentSuffix}`]: cxx,
    [`AR_${targetConfig.cargoEnvironmentSuffix}`]: ar,
    [`CARGO_TARGET_${targetConfig.cargoEnvironmentSuffix.toUpperCase()}_LINKER`]: cc,
    WRY_ANDROID_PACKAGE: identifier,
    TAURI_ANDROID_PACKAGE_UNESCAPED: identifier,
    WRY_ANDROID_LIBRARY: rustLibrary,
    TAURI_ANDROID_PROJECT_PATH: androidDir,
    WRY_ANDROID_KOTLIN_FILES_OUT_DIR: path.join(packageSourceDir, 'generated'),
  };
}

if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(identifier)) {
  fail('tauri.conf.json identifier가 Android package로 유효하지 않습니다.');
}
if (!targetConfig) fail(`지원하지 않는 Android debug target입니다: ${requestedTarget}`);
if (!fs.existsSync(path.join(androidDir, 'gradlew.bat')) && !fs.existsSync(path.join(androidDir, 'gradlew'))) {
  fail('생성된 Android 프로젝트가 없습니다. 먼저 pnpm tauri:android:init을 실행하세요.');
}
const requiredLocalTauriFiles = [
  path.join(androidDir, 'tauri.settings.gradle'),
  path.join(appDir, 'tauri.build.gradle.kts'),
  path.join(appDir, 'tauri.properties'),
];
const missingLocalTauriFiles = requiredLocalTauriFiles.filter((file) => !fs.existsSync(file));
if (missingLocalTauriFiles.length > 0) {
  fail(
    `clean clone 초기화가 필요합니다. pnpm tauri:android:init을 먼저 실행하세요. missing=${missingLocalTauriFiles
      .map((file) => path.relative(root, file))
      .join(',')}`,
  );
}

const sdkRoot = findAndroidSdk();
if (!sdkRoot) fail('Android SDK를 찾을 수 없습니다. ANDROID_HOME을 설정하세요.');
const ndkRoot = findNdk(sdkRoot);
if (!ndkRoot) fail('Android NDK를 찾을 수 없습니다. NDK_HOME을 설정하세요.');
const javaHome = findJavaHome();
if (!javaHome) fail('JDK 21을 찾을 수 없습니다. JAVA_HOME을 JDK 21로 설정하세요.');
const env = androidCargoEnvironment(sdkRoot, ndkRoot, javaHome);

run('pnpm', ['build']);
run('pnpm', ['tauri:android:sync-provider-plugin']);
run(
  'cargo',
  [
    'build',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--locked',
    '--target',
    targetConfig.rustTriple,
    '--release',
    '--features',
    'tauri/custom-protocol',
  ],
  { env },
);

const nativeLibrary = path.join(tauriDir, 'target', targetConfig.rustTriple, 'release', `lib${rustLibrary}.so`);
if (!fs.existsSync(nativeLibrary)) fail(`빌드된 native library가 없습니다: ${nativeLibrary}`);
const jniDirectory = path.join(appDir, 'src', 'main', 'jniLibs', targetConfig.abi);
fs.mkdirSync(jniDirectory, { recursive: true });
fs.copyFileSync(nativeLibrary, path.join(jniDirectory, `lib${rustLibrary}.so`));

const assetDirectory = path.join(appDir, 'src', 'main', 'assets');
fs.mkdirSync(assetDirectory, { recursive: true });
const productionTauriConfig = structuredClone(tauriConfig);
if (productionTauriConfig.build) delete productionTauriConfig.build.devUrl;
fs.writeFileSync(path.join(assetDirectory, 'tauri.conf.json'), JSON.stringify(productionTauriConfig));

const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
run(
  gradle,
  [
    `:app:assemble${targetConfig.gradleFlavor}Debug`,
    '-x',
    `:app:rustBuild${targetConfig.gradleFlavor}Debug`,
    '--console=plain',
  ],
  {
    cwd: androidDir,
    env,
  },
);

const apk = path.join(appDir, 'build', 'outputs', 'apk', requestedTarget, 'debug', `app-${requestedTarget}-debug.apk`);
if (!fs.existsSync(apk)) fail('Gradle은 성공했지만 debug APK를 찾을 수 없습니다.');
const bytes = fs.readFileSync(apk);
const digest = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
console.log(`[통과] Android ${requestedTarget} debug APK: ${path.relative(root, apk)}`);
console.log(`[통과] size=${bytes.length} sha256=${digest}`);
