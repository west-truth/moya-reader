import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const strict = process.argv.includes('--strict');
const args = ['check', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--target', 'aarch64-linux-android'];

function findNdkRoot() {
  const direct = [process.env.NDK_HOME, process.env.ANDROID_NDK_HOME].filter(Boolean);
  const sdkRoot =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined) ||
    (process.env.HOME
      ? path.join(process.env.HOME, process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk')
      : undefined);
  if (sdkRoot) {
    const sideBySideRoot = path.join(sdkRoot, 'ndk');
    if (existsSync(sideBySideRoot)) {
      const installed = readdirSync(sideBySideRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(sideBySideRoot, entry.name))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      direct.push(...installed);
    }
  }
  return direct.find((candidate) => candidate && existsSync(candidate));
}

function androidCargoEnvironment() {
  const ndkRoot = findNdkRoot();
  if (!ndkRoot) return process.env;
  let host = 'linux-x86_64';
  if (process.platform === 'win32') host = 'windows-x86_64';
  if (process.platform === 'darwin') host = 'darwin-x86_64';
  const bin = path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', host, 'bin');
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const api = process.env.ANDROID_MIN_SDK_VERSION || '24';
  const cc = path.join(bin, `aarch64-linux-android${api}-clang${suffix}`);
  const cxx = path.join(bin, `aarch64-linux-android${api}-clang++${suffix}`);
  const ar = path.join(bin, `llvm-ar${executableSuffix}`);
  if (![cc, cxx, ar].every(existsSync)) return process.env;
  return {
    ...process.env,
    CC_aarch64_linux_android: cc,
    CXX_aarch64_linux_android: cxx,
    AR_aarch64_linux_android: ar,
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: cc,
  };
}

const result = spawnSync('cargo', args, {
  encoding: 'utf8',
  env: androidCargoEnvironment(),
  maxBuffer: 20 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const status = typeof result.status === 'number' ? result.status : 1;
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

function exitEnvironmentBlocker(statusCode) {
  process.exit(strict ? statusCode || 1 : 0);
}

if (result.error) {
  console.error(`[실패] cargo 실행 불가 - ${result.error.message}`);
  exitEnvironmentBlocker(1);
}

if (status === 0) {
  console.log('[통과] Android Rust target cargo check 통과');
  process.exit(0);
}

const missingNdkClang =
  /(?:aarch64-linux-android(?:\d+)?-clang|clang\.exe)/i.test(output) &&
  /(?:ToolNotFound|failed to find tool|program not found)/i.test(output);

if (missingNdkClang) {
  console.log('[APK 차단] Android NDK clang toolchain이 없습니다.');
  console.log('- 데스크톱/웹 앱 코드 오류가 아니라 APK용 네이티브 컴파일 환경 문제입니다.');
  console.log('- Android Studio SDK Manager에서 NDK를 설치하고 ANDROID_HOME/NDK_HOME을 설정한 뒤 다시 실행하세요.');
  if (!strict)
    console.log(
      '- 상태 확인 명령은 여기서 실패 처리하지 않습니다. CI/완료 게이트에서는 pnpm check:android-rust:strict를 사용하세요.',
    );
  exitEnvironmentBlocker(status);
}

const missingRustTarget =
  /(?:can't find crate for `std`|target may not be installed|rustup target add aarch64-linux-android)/i.test(output);

if (missingRustTarget) {
  console.log('[APK 차단] Android Rust target이 설치되어 있지 않습니다.');
  console.log('- `rustup target add aarch64-linux-android` 실행 후 다시 확인하세요.');
  if (!strict)
    console.log(
      '- 상태 확인 명령은 여기서 실패 처리하지 않습니다. CI/완료 게이트에서는 pnpm check:android-rust:strict를 사용하세요.',
    );
  exitEnvironmentBlocker(status);
}

console.error(`[실패] Android Rust target cargo check 실패(exit ${status})`);
console.error(output.trim().split(/\r?\n/).slice(-80).join('\n'));
process.exit(status);
