import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const source = path.join(root, 'src-tauri/mobile/android/DocumentIoPlugin.kt');
const tauriConfigPath = path.join(root, 'src-tauri/tauri.conf.json');
const androidProject = path.join(root, 'src-tauri/gen/android');
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
const identifier = String(tauriConfig.identifier ?? '').trim();
if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(identifier)) {
  console.error('[APK 차단] src-tauri/tauri.conf.json identifier가 Android package로 사용할 수 없습니다.');
  process.exit(1);
}
const pluginPackage = `${identifier}.plugins`;
const target = path.join(androidProject, 'app/src/main/java', ...pluginPackage.split('.'), 'DocumentIoPlugin.kt');

if (!fs.existsSync(source)) {
  console.error('[APK 차단] Android document I/O plugin 원본이 없습니다.');
  process.exit(1);
}

const sourceText = fs.readFileSync(source, 'utf8');
const packageMatch = sourceText.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*$/m);
if (packageMatch?.[1] !== pluginPackage) {
  console.error(`[APK 차단] Android document I/O plugin package가 앱 identifier와 다릅니다. expected=${pluginPackage}`);
  process.exit(1);
}

if (!fs.existsSync(androidProject)) {
  console.error('[APK 차단] src-tauri/gen/android가 없습니다. 먼저 pnpm tauri:android:init을 실행하세요.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`[통과] Android document I/O plugin 동기화: ${path.relative(root, target)}`);
