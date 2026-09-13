import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProject, boundedFile, checkProjectPackage, runProjectSource, type DevelopmentFixture } from './project';
import type { SourceMethod } from '@noveldesk/extension-contracts/source-protocol';

const projectPath = (path: string) => resolve(fileURLToPath(new URL('../../', import.meta.url)), path);

async function main() {
  const [command, folder, ...args] = process.argv.slice(2);
  if (!['check', 'pack', 'run'].includes(command) || !folder)
    throw new Error(
      'Usage: pnpm extension:dev <check|pack|run> <folder> [--out file.moyaext] [--method source.listWorks --input input.json --fixture fixtures.json | --network]',
    );
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!['--out', '--method', '--input', '--fixture', '--network'].includes(name) || options.has(name))
      throw new Error('invalid_option');
    const value = name === '--network' ? 'true' : args[++i];
    if (!value || value.startsWith('--')) throw new Error('missing_option_value');
    options.set(name, value);
  }
  const allowed =
    command === 'run' ? ['--method', '--input', '--fixture', '--network'] : command === 'pack' ? ['--out'] : [];
  if (
    [...options.keys()].some((key) => !allowed.includes(key)) ||
    (options.has('--network') && options.has('--fixture'))
  )
    throw new Error('invalid_option');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const pkg = await buildProject(projectPath(folder));
    await checkProjectPackage(pkg, controller.signal);
    if (command === 'pack') {
      const output = projectPath(
        options.get('--out') ?? `${pkg.manifest.extension.id}-${pkg.manifest.extension.version}.moyaext`,
      );
      if (!output.endsWith('.moyaext')) throw new Error('output_requires_moyaext');
      controller.signal.throwIfAborted();
      // Never overwrite an existing build/user file; packages are immutable by version/digest.
      await writeFile(output, new Uint8Array(await pkg.archive.arrayBuffer()), { flag: 'wx' });
      console.log(
        JSON.stringify({
          output,
          id: pkg.manifest.extension.id,
          version: pkg.manifest.extension.version,
          digest: pkg.digest,
        }),
      );
    } else if (command === 'run') {
      const method = (options.get('--method') ?? 'source.listWorks') as SourceMethod;
      const input = options.has('--input')
        ? JSON.parse((await boundedFile(projectPath(options.get('--input')!), 1024 * 1024)).toString('utf8'))
        : { sourceId: pkg.manifest.extension.contributes!.externalSources![0].id };
      const fixtures: DevelopmentFixture[] = options.has('--fixture')
        ? JSON.parse((await boundedFile(projectPath(options.get('--fixture')!), 2 * 1024 * 1024)).toString('utf8'))
        : [];
      if (
        !Array.isArray(fixtures) ||
        fixtures.length > 256 ||
        fixtures.some(
          (entry) =>
            !entry ||
            typeof entry.url !== 'string' ||
            (typeof entry.body !== 'string' && typeof entry.bodyBase64 !== 'string') ||
            (entry.body !== undefined && entry.bodyBase64 !== undefined),
        )
      )
        throw new Error('invalid_fixtures');
      const value = await runProjectSource(pkg, method, input, {
        network: options.has('--network'),
        fixtures,
        signal: controller.signal,
      });
      // Raw downloaded text/images are deliberately not printed to terminal or build logs.
      console.log(
        JSON.stringify(
          {
            result: value.result,
            assets: value.assets.map(({ handle, bytes, contentType }) => ({
              handle,
              byteLength: bytes.length,
              contentType,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        JSON.stringify({
          id: pkg.manifest.extension.id,
          version: pkg.manifest.extension.version,
          valid: true,
          sources: pkg.manifest.extension.contributes!.externalSources!.length,
        }),
      );
    }
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

main().catch((error: unknown) => {
  // esbuild errors contain source snippets/paths; print only the explicit developer diagnostic text.
  const buildError = error as { errors?: { text: string }[] };
  console.error(
    buildError.errors?.map(({ text }) => text).join('\n') ||
      (error instanceof Error ? error.message : 'extension_command_failed'),
  );
  process.exitCode = 1;
});
