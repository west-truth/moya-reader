import { execFile } from 'node:child_process';
import { readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const exec = promisify(execFile);
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('이전 서버의 실행 기록을 확인하지 못했습니다.');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function portAvailable(port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', (error) => (error.code === 'EADDRINUSE' ? resolve(false) : reject(error)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
async function samePostgres(pid, executable, db, startedAt) {
  if (process.platform === 'win32') {
    // Only a validated numeric PID is embedded; paths never enter shell source.
    const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if($p){@{exe=$p.ExecutablePath;started=([DateTimeOffset]$p.CreationDate).ToUnixTimeSeconds()}|ConvertTo-Json -Compress}`;
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10_000 },
    );
    const info = JSON.parse(stdout);
    return (
      info.exe &&
      path.resolve(info.exe).toLowerCase() === path.resolve(executable).toLowerCase() &&
      Math.abs(info.started - startedAt) <= 2
    );
  }
  const [exe, cwd] = await Promise.all([realpath(`/proc/${pid}/exe`), realpath(`/proc/${pid}/cwd`)]);
  return exe === (await realpath(executable)) && cwd === (await realpath(db));
}

/** Called only while the native guard holds the profile's OS lock. */
export async function recoverEmbeddedProfile({ profileDir, postgresBin, redisCli, onPhase = () => {} }) {
  if (process.env.MOYA_PROFILE_GUARDED !== '1')
    throw new Error('이 서재는 이미 실행 중이거나 복구가 필요합니다. 모야 앱으로 다시 열어 주세요.');
  const lockPath = path.join(profileDir, 'server.lock');
  const original = await readFile(lockPath, 'utf8');
  const owner = JSON.parse(original);
  if (alive(owner.pid)) throw new Error('이 서재의 이전 서버가 아직 실행 중입니다. 종료 후 다시 시도해 주세요.');
  onPhase('recovering');
  const credentials = JSON.parse(await readFile(path.join(profileDir, 'server-credentials.json'), 'utf8'));
  if (
    credentials.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(credentials.redisPassword) ||
    !['api', 'redis', 'postgres'].every(
      (name) =>
        Number.isInteger(credentials.ports?.[name]) && credentials.ports[name] > 0 && credentials.ports[name] <= 65535,
    )
  )
    throw new Error('복구할 서버 설정을 확인하지 못했습니다. 기존 자료를 보존했습니다.');
  // API/worker receive IPC disconnect when their launcher dies. Give them time to drain.
  for (const child of owner.children ?? []) {
    if (!['api', 'worker'].includes(child.label)) continue;
    for (let attempt = 0; attempt < 300 && alive(child.pid); attempt++) await delay(100);
    if (alive(child.pid)) throw new Error('이전 서재 작업이 정리 중입니다. 잠시 후 다시 시도해 주세요.');
  }
  for (let attempt = 0; attempt < 50 && !(await portAvailable(credentials.ports.api)); attempt++) await delay(100);
  if (!(await portAvailable(credentials.ports.api)))
    throw new Error('이전 서재 연결이 정리 중이거나 포트가 사용 중입니다. 잠시 후 다시 시도해 주세요.');
  const db = path.join(profileDir, 'postgres');
  const pidFile = await readFile(path.join(db, 'postmaster.pid'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (pidFile) {
    const lines = pidFile.split(/\r?\n/);
    const pid = Number(lines[0]);
    if (alive(pid)) {
      const executable = path.join(postgresBin, process.platform === 'win32' ? 'postgres.exe' : 'postgres');
      if (path.resolve(lines[1]) !== path.resolve(db) || !(await samePostgres(pid, executable, db, Number(lines[2]))))
        throw new Error('기존 DB 프로세스의 소유권을 확인하지 못했습니다. 기존 자료를 보존했습니다.');
      await exec(
        path.join(postgresBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'),
        ['-D', 'postgres', '-m', 'fast', '-w', '-t', '30', 'stop'],
        { cwd: profileDir, windowsHide: true, timeout: 35_000 },
      );
    }
  }
  if (!(await portAvailable(credentials.ports.redis))) {
    // The random per-profile password prevents shutting down another Redis instance.
    await exec(redisCli, ['-h', '127.0.0.1', '-p', String(credentials.ports.redis), 'SHUTDOWN', 'SAVE'], {
      env: { ...process.env, REDISCLI_AUTH: credentials.redisPassword },
      windowsHide: true,
      timeout: 10_000,
    });
  }
  if (!(await portAvailable(credentials.ports.postgres)) || !(await portAvailable(credentials.ports.redis)))
    throw new Error('이전 저장 프로세스가 아직 정리 중입니다. 다시 시도해 주세요.');
  if ((await readFile(lockPath, 'utf8')) !== original)
    throw new Error('서재 실행 상태가 변경되어 복구를 중단했습니다.');
  await rm(lockPath);
}
