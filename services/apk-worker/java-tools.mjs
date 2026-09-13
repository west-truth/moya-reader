import { spawn } from 'node:child_process';
import { readdir, rename } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApkWorkerSupervisor } from './supervisor.mjs';

/** No shell commands, inherited credentials, or full server JARs. Paths originate only from the installation store. */
export async function createJavaApkTools(java, build, { systemRoot = process.env.SystemRoot } = {}) {
  const env = systemRoot ? { SystemRoot: systemRoot } : {};
  const dependencies = (await readdir(join(build, 'dependencies'))).filter((name) => name.endsWith('.jar'));
  const main = join(build, 'target', 'apk-worker-0.1.0.jar');
  const toolsPath = [main, ...dependencies.map((name) => join(build, 'dependencies', name))].join(delimiter);
  const runtimePath = [
    main,
    ...dependencies
      .filter((name) => !/^(?:dex-|d2j-|asm-|antlr|apk-parser-|apksig-)/.test(name))
      .map((name) => join(build, 'dependencies', name)),
  ].join(delimiter);
  async function tool(args, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(java, ['-Xmx256m', '-cp', toolsPath, ...args], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parts = [];
      let length = 0;
      let failure;
      const fail = (code) => {
        failure = code;
        child.kill('SIGKILL');
      };
      const cancel = () => fail('cancelled');
      signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => fail('apk_tool_timeout'), 60000);
      child.stdout.on('data', (part) => {
        length += part.length;
        if (length > 1024 * 1024) fail('apk_tool_output_limit');
        else parts.push(part);
      });
      child.stderr.on('data', () => {});
      child.on('error', () => {
        failure = 'apk_worker_unavailable';
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (failure || code !== 0) reject(new Error(failure ?? 'apk_verification_failed'));
        else resolve(Buffer.concat(parts).toString('utf8'));
      });
    });
  }
  function worker(archive, metadata, directory) {
    return new ApkWorkerSupervisor(
      java,
      [
        '-Xmx192m',
        '-cp',
        [runtimePath, archive].join(delimiter),
        'org.moya.apk.Main',
        metadata.entry,
        directory,
        metadata.pkg,
      ],
      { env, pagesTimeoutMs: 165000, chaptersTimeoutMs: 600000 },
    );
  }
  return {
    worker,
    inspect: async (archive, signal) => JSON.parse(await tool(['org.moya.apk.Inspect', archive], signal)),
    convert: async (archive, target, signal) => {
      const staged = target + '.' + randomUUID() + '.tmp';
      await tool(['com.googlecode.dex2jar.tools.Dex2jarCmd', archive, '-o', staged, '-f', '-dsn'], signal);
      signal.throwIfAborted();
      await rename(staged, target);
    },
    describe: async (archive, metadata, directory, signal) => {
      const child = worker(archive, metadata, directory);
      try {
        return await child.request('describe', {}, signal);
      } finally {
        child.close();
      }
    },
  };
}
