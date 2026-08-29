import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceDir = join(workspace, 'services', 'webnovel-metadata-collector');
const buildRoot = join(workspace, '.tmp', 'webnovel-metadata-collector-sidecar');
const environmentRoot = join(workspace, '.tmp', 'webnovel-metadata-collector-bundle-environment');
const outputDir = join(workspace, 'src-tauri', 'collector-sidecar');
const executableName = process.platform === 'win32' ? 'webnovel-metadata-collector.exe' : 'webnovel-metadata-collector';
const bootstrapPython = process.env.MOYA_COLLECTOR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const environmentPython = join(
  environmentRoot,
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);
const environmentMarker = join(environmentRoot, '.moya-bundle-environment');
const windowModeArguments = process.env.MOYA_COLLECTOR_BUNDLE_CONSOLE === '1' ? [] : ['--noconsole'];

for (const temporaryPath of [buildRoot, environmentRoot]) {
  if (!temporaryPath.startsWith(`${join(workspace, '.tmp')}${sep}`)) {
    throw new Error('collector sidecar temporary directory escaped the workspace temp directory');
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspace,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(options.failureMessage ?? `${command} ${args.join(' ')} failed`);
  }
  return result.stdout?.trim() ?? '';
}

const pythonIdentity = run(
  bootstrapPython,
  [
    '-c',
    'import platform,sys; print(f"{sys.implementation.name}|{platform.python_version()}|{platform.system()}|{platform.machine()}")',
  ],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
    failureMessage: `Python ${bootstrapPython} is unavailable; Python 3.11 or newer is required for the metadata collector bundle`,
  },
);
const environmentFingerprint = createHash('sha256')
  .update('moya-webnovel-metadata-collector-bundle-v2\0')
  .update(pythonIdentity)
  .update('\0')
  .update(readFileSync(join(serviceDir, 'pyproject.toml')))
  .digest('hex');
const environmentReady =
  existsSync(environmentPython) &&
  existsSync(environmentMarker) &&
  readFileSync(environmentMarker, 'utf8').trim() === environmentFingerprint;

if (!environmentReady) {
  rmSync(environmentRoot, { recursive: true, force: true });
  run(bootstrapPython, ['-m', 'venv', environmentRoot], {
    failureMessage: 'metadata collector isolated Python environment could not be created',
  });
  run(environmentPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-e', `${serviceDir}[auth,bundle]`], {
    failureMessage: 'metadata collector isolated dependencies could not be installed',
  });
  writeFileSync(environmentMarker, `${environmentFingerprint}\n`, 'utf8');
}

rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(join(buildRoot, 'dist'), { recursive: true });
mkdirSync(outputDir, { recursive: true });

const addDataSeparator = process.platform === 'win32' ? ';' : ':';
run(
  environmentPython,
  [
    '-m',
    'PyInstaller',
    '--noconfirm',
    '--clean',
    '--onefile',
    ...windowModeArguments,
    '--name',
    'webnovel-metadata-collector',
    '--paths',
    serviceDir,
    '--add-data',
    `${join(serviceDir, 'app', 'web')}${addDataSeparator}app/web`,
    '--collect-all',
    'playwright',
    '--hidden-import',
    'uvicorn.logging',
    '--hidden-import',
    'uvicorn.loops.auto',
    '--hidden-import',
    'uvicorn.protocols.http.auto',
    '--hidden-import',
    'uvicorn.protocols.websockets.auto',
    '--hidden-import',
    'uvicorn.lifespan.on',
    '--distpath',
    join(buildRoot, 'dist'),
    '--workpath',
    join(buildRoot, 'work'),
    '--specpath',
    join(buildRoot, 'spec'),
    join(serviceDir, 'app', 'sidecar.py'),
  ],
  {
    failureMessage:
      'metadata collector bundle failed; remove .tmp/webnovel-metadata-collector-bundle-environment and retry',
  },
);

const built = join(buildRoot, 'dist', executableName);
if (!existsSync(built)) throw new Error(`metadata collector bundle output is missing: ${built}`);
const target = join(outputDir, executableName);
copyFileSync(built, target);
if (process.platform !== 'win32') {
  const { chmodSync } = await import('node:fs');
  chmodSync(target, 0o755);
}
run(
  environmentPython,
  [
    join(workspace, 'scripts', 'generate-webnovel-metadata-collector-license-inventory.py'),
    '--output-dir',
    join(outputDir, 'third_party', 'licenses', 'python'),
    '--inventory',
    join(outputDir, 'python-license-inventory.json'),
    '--project-license',
    join(workspace, 'LICENSE'),
  ],
  { failureMessage: 'metadata collector Python license inventory could not be generated' },
);
console.log(`Bundled metadata collector: ${target}`);
console.log(`Isolated bundle environment: ${environmentRoot}`);
