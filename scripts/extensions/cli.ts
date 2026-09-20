import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildProject, boundedFile, checkProjectPackage, runProjectSource, type DevelopmentFixture } from './project';
import type { SourceMethod } from '@noveldesk/extension-contracts/source-protocol';
import { scaffoldProject } from './scaffold';
import { buildRepositoryIndex } from './repository';
import { generatePublisherKey, loadPublisherKey } from './signing';
import { formatDeveloperError, watchDevelopmentProject } from './development';
import { startDevelopmentPreview } from './preview';

// Resolve user paths from the invoking project, including independently installed CLI usage.
const projectPath = (path: string) => resolve(process.cwd(), path);

async function main() {
  const [command, folder, ...args] = process.argv.slice(2);
  if (!['init', 'check', 'pack', 'run', 'dev', 'preview', 'index', 'keygen'].includes(command) || !folder)
    throw new Error(
      'Usage: moya-extension keygen <new-key-folder> | index <archives-folder> --url https://host/index.json --out index.json [--name Name] | init <new-folder> --id org.example.source [--kind text|images --name Name] | <check|pack|run|dev|preview> <folder> [--out file.moyaext --key publisher.pem] [--method source.listWorks --input input.json --fixture fixtures.json | --network] [--preferences local-preferences.json]',
    );
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (
      ![
        '--out',
        '--method',
        '--input',
        '--fixture',
        '--preferences',
        '--network',
        '--id',
        '--kind',
        '--name',
        '--url',
        '--key',
      ].includes(name) ||
      options.has(name)
    )
      throw new Error('invalid_option');
    const value = name === '--network' ? 'true' : args[++i];
    if (!value || value.startsWith('--')) throw new Error('missing_option_value');
    options.set(name, value);
  }
  const allowed =
    command === 'index'
      ? ['--url', '--out', '--name']
      : command === 'init'
        ? ['--id', '--kind', '--name']
        : command === 'run' || command === 'dev' || command === 'preview'
          ? ['--method', '--input', '--fixture', '--network', '--preferences']
          : command === 'pack'
            ? ['--out', '--key']
            : [];
  if (
    [...options.keys()].some((key) => !allowed.includes(key)) ||
    (options.has('--network') && options.has('--fixture'))
  )
    throw new Error('invalid_option');
  if (command === 'keygen') {
    console.log(JSON.stringify(await generatePublisherKey(projectPath(folder))));
    return;
  }
  if (command === 'index') {
    if (!options.get('--url') || !options.get('--out')) throw new Error('missing_repository_options');
    const index = await buildRepositoryIndex(projectPath(folder), options.get('--url')!, options.get('--name'));
    const output = projectPath(options.get('--out')!);
    await writeFile(output, JSON.stringify(index, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, packages: index.packages.length }));
    return;
  }
  if (command === 'init') {
    if (!options.get('--id')) throw new Error('missing_project_id');
    console.log(
      JSON.stringify(
        await scaffoldProject(projectPath(folder), {
          id: options.get('--id')!,
          name: options.get('--name'),
          kind: options.get('--kind') ?? 'text',
        }),
      ),
    );
    return;
  }
  if (command === 'dev' || command === 'preview') {
    if (
      (options.has('--input') ||
        options.has('--fixture') ||
        options.has('--network') ||
        options.has('--preferences')) &&
      !options.has('--method')
    )
      throw new Error('development_method_required');
    const development = {
      method: options.get('--method') as SourceMethod | undefined,
      input: options.has('--input') ? projectPath(options.get('--input')!) : undefined,
      fixture: options.has('--fixture') ? projectPath(options.get('--fixture')!) : undefined,
      preferences: options.has('--preferences') ? projectPath(options.get('--preferences')!) : undefined,
      network: options.has('--network'),
    };
    if (command === 'dev') await watchDevelopmentProject(projectPath(folder), development);
    else {
      const preview = await startDevelopmentPreview(projectPath(folder), development);
      console.log(JSON.stringify({ event: 'preview-listening', url: preview.url, network: development.network }));
      await new Promise<void>((resolveDone) => {
        const stop = () => void preview.close().then(resolveDone);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    }
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const pkg = await buildProject(
      projectPath(folder),
      options.has('--key') ? await loadPublisherKey(projectPath(options.get('--key')!)) : undefined,
    );
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
          publisherFingerprint: pkg.publisherFingerprint,
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
        preferences: options.has('--preferences')
          ? JSON.parse((await boundedFile(projectPath(options.get('--preferences')!), 64 * 1024)).toString('utf8'))
          : undefined,
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
  console.error(formatDeveloperError(error));
  process.exitCode = 1;
});
