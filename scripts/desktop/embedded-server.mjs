import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntil(check, description, failed, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (failed()) throw new Error(`${description}: a managed process exited; see the profile logs`);
    if (await check().catch(() => false)) return;
    await delay(150);
  }
  throw new Error(`${description} timed out; see the profile logs`);
}

/** The same launcher runs a staged development payload and the app's bundled payload. */
export async function startEmbeddedServer({ runtimeFile, profileDir }) {
  runtimeFile = path.resolve(runtimeFile);
  profileDir = path.resolve(profileDir);
  const manifest = JSON.parse(await readFile(runtimeFile, 'utf8'));
  if (manifest.version !== 1 || manifest.platform !== `${process.platform}-${process.arch}`) {
    throw new Error('Unsupported embedded server runtime');
  }
  const runtimePath = (name) => {
    if (typeof manifest[name] !== 'string' || !manifest[name]) throw new Error(`Missing runtime ${name}`);
    return path.resolve(path.dirname(runtimeFile), manifest[name]);
  };
  const node = runtimePath('node');
  const postgresBin = runtimePath('postgresBin');
  const redisServer = runtimePath('redisServer');
  const redisCli = runtimePath('redisCli');
  const serverDir = runtimePath('serverDir');
  const webDir = runtimePath('webDir');
  const pg = (name) => path.join(postgresBin, name + (process.platform === 'win32' ? '.exe' : ''));
  if (!Number.isInteger(manifest.postgresMajor)) throw new Error('Missing PostgreSQL data version');
  await Promise.all(
    [
      node,
      redisServer,
      redisCli,
      ...['postgres', 'initdb', 'pg_ctl', 'pg_isready'].map(pg),
      path.join(serverDir, 'dist/index.js'),
      path.join(serverDir, 'dist/worker.js'),
      path.join(webDir, 'index.html'),
    ].map((file) => access(file)),
  );
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(profileDir, 'server.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new Error('This server profile is already open or needs recovery; server.lock was preserved');
  });
  const children = [];
  const logs = [];
  let stopping = false;
  let stopPromise;
  let pgChild;
  let redisChild;
  let api;
  let worker;
  let credentials;
  let unexpectedExit;
  const failed = () =>
    children.some((child) => child.exitCode !== null || child.signalCode !== null || child.spawnFailed);
  const db = path.join(profileDir, 'postgres');
  const queue = path.join(profileDir, 'queue');

  async function command(label, executable, args, options = {}) {
    const log = await open(path.join(profileDir, `${label}.log`), 'a', 0o600);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { windowsHide: true, ...options, stdio: ['ignore', log.fd, log.fd] });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`${label} timed out`));
        }, 60_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`${label} failed (${code}); see profile logs`));
        });
      });
    } finally {
      await log.close();
    }
  }

  async function launch(label, executable, args, options = {}, ipc = false) {
    const log = await open(path.join(profileDir, `${label}.log`), 'a', 0o600);
    logs.push(log);
    const child = spawn(executable, args, {
      windowsHide: true,
      ...options,
      stdio: ['ignore', log.fd, log.fd, ...(ipc ? ['ipc'] : [])],
    });
    children.push(child);
    child.closed = new Promise((resolve) => {
      child.once('error', () => {
        child.spawnFailed = true;
        resolve();
      });
      child.once('close', resolve);
    });
    child.once('exit', (code) => {
      if (!stopping) unexpectedExit?.(new Error(`${label} stopped unexpectedly (${code})`));
    });
    return child;
  }

  async function stopNode(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null || child.spawnFailed) return;
    if (child.connected) child.send('shutdown');
    // Active imports are drained by the existing worker before storage is stopped.
    await child.closed;
  }

  function stop() {
    return (stopPromise ??= (async () => {
      stopping = true;
      // Close admission first; the worker can still commit its current jobs.
      await stopNode(api);
      await stopNode(worker);
      if (redisChild && redisChild.exitCode === null && !redisChild.spawnFailed) {
        await command(
          'redis-stop',
          redisCli,
          ['-h', '127.0.0.1', '-p', String(credentials.ports.redis), 'SHUTDOWN', 'SAVE'],
          {
            env: { ...process.env, REDISCLI_AUTH: credentials.redisPassword },
          },
        );
        await redisChild.closed;
      }
      if (pgChild && pgChild.exitCode === null && !pgChild.spawnFailed) {
        await command('postgres-stop', pg('pg_ctl'), ['-D', db, '-m', 'fast', '-w', '-t', '30', 'stop']);
        await pgChild.closed;
      }
      await Promise.all(logs.map((log) => log.close()));
      await lock.close();
      await rm(lockPath);
    })());
  }

  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const credentialsPath = path.join(profileDir, 'server-credentials.json');
    credentials = await readFile(credentialsPath, 'utf8')
      .then(JSON.parse)
      .catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
    if (!credentials) {
      const ports = {};
      for (const name of ['postgres', 'redis', 'api']) {
        do {
          ports[name] = await unusedPort();
        } while (Object.entries(ports).some(([k, v]) => k !== name && v === ports[name]));
      }
      credentials = {
        version: 1,
        ports,
        postgresPassword: randomBytes(32).toString('hex'),
        redisPassword: randomBytes(32).toString('hex'),
        authToken: randomBytes(32).toString('hex'),
      };
      await writeFile(credentialsPath, JSON.stringify(credentials), { flag: 'wx', mode: 0o600 });
    }
    if (
      credentials.version !== 1 ||
      !['postgresPassword', 'redisPassword', 'authToken'].every((k) => /^[a-f0-9]{64}$/.test(credentials[k])) ||
      !['postgres', 'redis', 'api'].every(
        (k) => Number.isInteger(credentials.ports?.[k]) && credentials.ports[k] > 0 && credentials.ports[k] <= 65535,
      )
    ) {
      throw new Error('Invalid server profile configuration; existing data was preserved');
    }
    const pgVersion = await readFile(path.join(db, 'PG_VERSION'), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (pgVersion && pgVersion.trim() !== String(manifest.postgresMajor))
      throw new Error('PostgreSQL data version mismatch');
    if (!pgVersion) {
      const staging = path.join(profileDir, `postgres-init-${randomUUID()}`);
      const passwordFile = path.join(profileDir, `init-password-${randomUUID()}`);
      try {
        await writeFile(passwordFile, credentials.postgresPassword, { mode: 0o600, flag: 'wx' });
        await command('initdb', pg('initdb'), [
          '-D',
          staging,
          '-U',
          'moya',
          '--pwfile',
          passwordFile,
          ...(manifest.postgresShare ? ['-L', runtimePath('postgresShare')] : []),
          '--auth-local=scram-sha-256',
          '--auth-host=scram-sha-256',
          '--encoding=UTF8',
          '--no-locale',
        ]);
        await rename(staging, db);
      } finally {
        await rm(passwordFile, { force: true });
      }
    }
    const databaseUrl = `postgres://moya:${credentials.postgresPassword}@127.0.0.1:${credentials.ports.postgres}/postgres`;
    pgChild = await launch('postgres', pg('postgres'), [
      '-D',
      db,
      '-h',
      '127.0.0.1',
      '-p',
      String(credentials.ports.postgres),
      '-c',
      'unix_socket_directories=',
      '-c',
      'shared_buffers=32MB',
      '-c',
      'max_connections=50',
    ]);
    await waitUntil(
      async () => {
        await command('postgres-ready', pg('pg_isready'), [
          '-h',
          '127.0.0.1',
          '-p',
          String(credentials.ports.postgres),
        ]);
        return true;
      },
      'PostgreSQL startup',
      failed,
    );
    await mkdir(queue, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(queue, 'redis.conf'),
      [
        'bind 127.0.0.1',
        `port ${credentials.ports.redis}`,
        'protected-mode yes',
        'daemonize no',
        `requirepass ${credentials.redisPassword}`,
        'appendonly yes',
        'appendfsync everysec',
        'dir ./',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    redisChild = await launch('redis', redisServer, ['redis.conf'], { cwd: queue });
    await waitUntil(
      async () => {
        await command('redis-ready', redisCli, ['-h', '127.0.0.1', '-p', String(credentials.ports.redis), 'PING'], {
          env: { ...process.env, REDISCLI_AUTH: credentials.redisPassword },
        });
        return true;
      },
      'Redis startup',
      failed,
    );
    const env = {
      ...process.env,
      MOYA_MANAGED_SERVER: '1',
      HOST: '127.0.0.1',
      PORT: String(credentials.ports.api),
      SERVER_EXPOSURE: 'loopback',
      DATABASE_URL: databaseUrl,
      REDIS_URL: `redis://:${credentials.redisPassword}@127.0.0.1:${credentials.ports.redis}/0`,
      SERVER_DATA_DIR: path.join(profileDir, 'server'),
      OBJECT_STORAGE_DIR: path.join(profileDir, 'objects'),
      STORAGE_CAPACITY_PATH: path.join(profileDir, 'objects'),
      SERVER_WEB_ROOT: webDir,
      READER_AUTH_TOKEN: credentials.authToken,
      RUN_MIGRATIONS_ON_START: 'true',
      DEFAULT_USER_ID: 'user_desktop',
    };
    await mkdir(env.OBJECT_STORAGE_DIR, { recursive: true, mode: 0o700 });
    api = await launch('api', node, [path.join(serverDir, 'dist/index.js')], { cwd: serverDir, env }, true);
    const url = `http://127.0.0.1:${credentials.ports.api}`;
    await waitUntil(
      async () => (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok,
      'API startup',
      failed,
    );
    worker = await launch('worker', node, [path.join(serverDir, 'dist/worker.js')], { cwd: serverDir, env }, true);
    await waitUntil(
      async () => (await fetch(`${url}/api/ready`, { signal: AbortSignal.timeout(1500) })).ok,
      'Worker startup',
      failed,
    );
    return {
      url,
      authToken: credentials.authToken,
      profileDir,
      stop,
      processIds: children.map((child) => child.pid),
      onUnexpectedExit(handler) {
        unexpectedExit = handler;
        if (failed()) handler(new Error('A managed process stopped'));
      },
    };
  } catch (error) {
    await stop().catch(() => {
      /* Keep the lock on incomplete shutdown. */
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [runtimeFile, profileDir] = process.argv.slice(2);
  if (!runtimeFile || !profileDir) throw new Error('Usage: embedded-server.mjs <runtime.json> <profile directory>');
  const server = await startEmbeddedServer({ runtimeFile, profileDir });
  console.log(JSON.stringify({ event: 'ready', url: server.url }));
  // Secrets only traverse the parent IPC channel, never stdout or a URL.
  process.send?.({ event: 'ready', url: server.url, authToken: server.authToken });
  const stop = () => {
    void server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.on('message', (message) => {
    if (message === 'shutdown') stop();
  });
  process.once('disconnect', stop);
  server.onUnexpectedExit(() => {
    void server.stop().finally(() => process.exit(1));
  });
}
