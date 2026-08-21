import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const brandingRoot = path.join(root, 'assets', 'branding');
const appIconSource = path.join(brandingRoot, 'moya-app-icon.png');
const wordmarkSource = path.join(brandingRoot, 'moya-wordmark.png');
const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const tauriIconRoot = path.join(root, 'src-tauri', 'icons');
const publicIconRoot = path.join(root, 'public', 'icons');
const publicBrandingRoot = path.join(root, 'public', 'branding');
const generatedAndroidResources = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');

function fail(message) {
  console.error(`[브랜드 자산 생성 실패] ${message}`);
  process.exit(1);
}

function readPngDimensions(file) {
  if (!fs.existsSync(file)) fail(`원본 파일이 없습니다: ${path.relative(root, file)}`);
  const header = fs.readFileSync(file).subarray(0, 24);
  const pngSignature = '89504e470d0a1a0a';
  if (header.length < 24 || header.subarray(0, 8).toString('hex') !== pngSignature) {
    fail(`PNG 파일만 사용할 수 있습니다: ${path.relative(root, file)}`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

const appIconSize = readPngDimensions(appIconSource);
const wordmarkSize = readPngDimensions(wordmarkSource);
if (appIconSize.width !== appIconSize.height) {
  fail(`앱 아이콘 원본은 정사각형이어야 합니다: ${appIconSize.width}x${appIconSize.height}`);
}
if (wordmarkSize.width <= wordmarkSize.height) {
  fail(`워드마크 원본은 가로형이어야 합니다: ${wordmarkSize.width}x${wordmarkSize.height}`);
}
if (!fs.existsSync(tauriCli)) fail('의존성이 없습니다. 먼저 pnpm install을 실행하세요.');

function runTauriIcon(args) {
  const result = spawnSync(process.execPath, [tauriCli, 'icon', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) fail('Tauri 아이콘 변환기가 종료되었습니다.');
}

const tauriSourceCopy = path.join(tauriIconRoot, 'icon-source.png');
const requiredNativeOutputs = [
  'icon.ico',
  'icon.icns',
  'icon.png',
  '32x32.png',
  'android/mipmap-xxxhdpi/ic_launcher.png',
  'ios/AppIcon-512@2x.png',
].map((relativePath) => path.join(tauriIconRoot, relativePath));
const nativeIconsCurrent =
  fs.existsSync(tauriSourceCopy) &&
  fs.readFileSync(tauriSourceCopy).equals(fs.readFileSync(appIconSource)) &&
  requiredNativeOutputs.every((file) => fs.existsSync(file));

if (nativeIconsCurrent) {
  console.log('[유지] 앱 아이콘 원본이 같아 Tauri native 파생 파일을 다시 만들지 않습니다.');
} else {
  const temporaryTauriRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moya-tauri-brand-'));
  try {
    runTauriIcon([appIconSource, '--output', temporaryTauriRoot]);
    fs.mkdirSync(tauriIconRoot, { recursive: true });
    fs.cpSync(temporaryTauriRoot, tauriIconRoot, { recursive: true, force: true });
    fs.copyFileSync(appIconSource, tauriSourceCopy);
  } finally {
    fs.rmSync(temporaryTauriRoot, { recursive: true, force: true });
  }
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moya-brand-'));
try {
  runTauriIcon([appIconSource, '--output', temporaryRoot, '--png', '32', '--png', '192', '--png', '512']);
  fs.mkdirSync(publicIconRoot, { recursive: true });
  for (const size of [32, 192, 512]) {
    fs.copyFileSync(path.join(temporaryRoot, `${size}x${size}.png`), path.join(publicIconRoot, `moya-${size}.png`));
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

fs.mkdirSync(publicBrandingRoot, { recursive: true });
fs.copyFileSync(wordmarkSource, path.join(publicBrandingRoot, 'moya-wordmark.png'));

const androidIconSource = path.join(tauriIconRoot, 'android');
if (fs.existsSync(generatedAndroidResources) && fs.existsSync(androidIconSource)) {
  fs.cpSync(androidIconSource, generatedAndroidResources, { recursive: true, force: true });
}

console.log(
  `[완료] 모야 브랜드 자산 생성: app=${appIconSize.width}x${appIconSize.height}, wordmark=${wordmarkSize.width}x${wordmarkSize.height}`,
);
