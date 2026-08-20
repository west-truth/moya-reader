import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2).filter((arg) => arg !== '--');

function hasArg(name) {
  return args.includes(name);
}

function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function run(command, commandArgs, options = {}) {
  const label = [command, ...commandArgs].join(' ');
  console.log(`\n$ ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === 'win32',
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = options.capture ? result.stderr?.trim() : '';
    throw new Error(`${label} failed with exit code ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }
  return result;
}

function dockerComposeArgs(projectName, composeFiles, extraArgs) {
  return ['compose', ...composeFiles.flatMap((file) => ['-f', file]), '-p', projectName, ...extraArgs];
}

async function main() {
  const dryRun = hasArg('--dry-run');
  const keepStack = hasArg('--keep-stack');
  const keepData = hasArg('--keep-data');
  const skipBuild = hasArg('--skip-build');
  const publicMode = hasArg('--public') || process.env.HOSTED_E2E_PUBLIC === '1';
  const includeAIWorkflow = hasArg('--include-ai-workflow') || process.env.HOSTED_E2E_INCLUDE_AI_WORKFLOW === '1';
  const projectName = argValue('--project-name', process.env.HOSTED_E2E_PROJECT ?? 'noveldesk-e2e');
  const webUrl = argValue('--web-url', process.env.HOSTED_WEB_URL ?? 'http://127.0.0.1:8080');
  const apiUrl = argValue('--api-url', process.env.HOSTED_API_URL ?? `${webUrl.replace(/\/+$/, '')}/api`);
  const timeoutMs = argValue('--timeout-ms', process.env.HOSTED_SMOKE_TIMEOUT_MS ?? '120000');
  let authToken = argValue('--auth-token', process.env.HOSTED_API_AUTH_TOKEN ?? process.env.READER_AUTH_TOKEN ?? '');
  if (publicMode && !authToken.trim()) {
    authToken = 'moya-hosted-e2e-token';
  }
  if (publicMode) {
    process.env.READER_AUTH_TOKEN = authToken.trim();
    if (!process.env.POSTGRES_PASSWORD?.trim()) {
      process.env.POSTGRES_PASSWORD = 'moya-e2e-postgres-password';
    }
    if (!process.env.MINIO_ROOT_USER?.trim()) {
      process.env.MINIO_ROOT_USER = 'moya-e2e-storage';
    }
    if (!process.env.MINIO_ROOT_PASSWORD?.trim()) {
      process.env.MINIO_ROOT_PASSWORD = 'moya-e2e-storage-password';
    }
  }
  const composeFiles = ['compose.yaml', ...(publicMode ? ['compose.public.yaml'] : [])];

  run('pnpm', ['check:hosted']);
  run('docker', dockerComposeArgs(projectName, composeFiles, ['config', '--quiet']));

  if (dryRun) {
    console.log('\nDry run passed. Docker daemon actions and live smoke were skipped.');
    return;
  }

  try {
    run('docker', ['info'], { capture: true });
  } catch (error) {
    throw new Error(
      `Docker daemon is not available. Start Docker Desktop or the Docker service, then rerun pnpm check:hosted:e2e. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const upArgs = dockerComposeArgs(projectName, composeFiles, ['up', ...(skipBuild ? [] : ['--build']), '-d']);
  run('docker', upArgs);

  try {
    const smokeArgs = [
      'scripts/hosted-live-smoke.mjs',
      '--web-url',
      webUrl,
      '--api-url',
      apiUrl,
      '--timeout-ms',
      timeoutMs,
    ];
    if (authToken.trim()) {
      smokeArgs.push('--auth-token', authToken.trim());
    }
    run('node', smokeArgs);

    if (includeAIWorkflow) {
      const aiWorkflowArgs = [
        'scripts/hosted-ai-workflow-smoke.mjs',
        '--web-url',
        webUrl,
        '--api-url',
        apiUrl,
        '--timeout-ms',
        timeoutMs,
      ];
      if (authToken.trim()) {
        aiWorkflowArgs.push('--auth-token', authToken.trim());
      }
      run('node', aiWorkflowArgs);
    }
  } finally {
    if (keepStack) {
      console.log(`\nKeeping Docker Compose stack '${projectName}' running.`);
    } else {
      run('docker', dockerComposeArgs(projectName, composeFiles, ['down', ...(keepData ? [] : ['--volumes'])]));
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
