import { watch } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { SourceMethod } from '@noveldesk/extension-contracts/source-protocol';
import { boundedFile, buildProject, checkProjectPackage, runProjectSource, type DevelopmentFixture } from './project';

interface DevelopmentOptions {
  readonly method?: SourceMethod;
  readonly input?: string;
  readonly fixture?: string;
  readonly network?: boolean;
}

const ignored = (path: string) =>
  path.split(/[\\/]/).some((part) => part === '.git' || part === 'node_modules' || part === 'dist' || part === '.tmp');

async function loadJson(path: string, maximum: number): Promise<unknown> {
  return JSON.parse((await boundedFile(path, maximum)).toString('utf8'));
}

function validFixtures(value: unknown): value is DevelopmentFixture[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(
      (entry) =>
        entry &&
        typeof entry.url === 'string' &&
        (typeof entry.body === 'string' || typeof entry.bodyBase64 === 'string') &&
        !(entry.body !== undefined && entry.bodyBase64 !== undefined),
    )
  );
}

function previewResult(value: unknown): unknown {
  if (value && typeof value === 'object' && 'items' in value && Array.isArray(value.items))
    return { itemCount: value.items.length, items: value.items.slice(0, 5) };
  const serialized = JSON.stringify(value);
  return serialized.length <= 12_000
    ? value
    : { type: Array.isArray(value) ? 'array' : typeof value, byteLength: serialized.length };
}

export function formatDeveloperError(error: unknown): string {
  const buildError = error as {
    errors?: Array<{
      text: string;
      location?: { file?: string; line?: number; column?: number; lineText?: string } | null;
    }>;
  };
  if (buildError.errors?.length)
    return buildError.errors
      .map(({ text, location }) => {
        if (!location?.file || !location.line) return text;
        const column = (location.column ?? 0) + 1;
        const source = location.lineText?.trimEnd();
        return `${location.file}:${location.line}:${column} ${text}${source ? `\n  ${source}` : ''}`;
      })
      .join('\n');
  return error instanceof Error ? error.message : 'extension_command_failed';
}

export async function runDevelopmentIteration(folder: string, options: DevelopmentOptions) {
  const pkg = await buildProject(folder);
  await checkProjectPackage(pkg);
  if (!options.method)
    return {
      id: pkg.manifest.extension.id,
      version: pkg.manifest.extension.version,
      sources: pkg.manifest.extension.contributes!.externalSources!.length,
    };
  const sourceId = pkg.manifest.extension.contributes!.externalSources![0].id;
  const input = options.input ? await loadJson(options.input, 1024 * 1024) : { sourceId };
  const fixtureValue = options.fixture ? await loadJson(options.fixture, 2 * 1024 * 1024) : [];
  if (!validFixtures(fixtureValue)) throw new Error('invalid_fixtures');
  const value = await runProjectSource(pkg, options.method, input, {
    network: options.network,
    fixtures: fixtureValue,
  });
  return {
    id: pkg.manifest.extension.id,
    version: pkg.manifest.extension.version,
    method: options.method,
    result: previewResult(value.result),
    assets: value.assets.map(({ bytes, contentType }) => ({ byteLength: bytes.length, contentType })),
  };
}

export async function watchDevelopmentProject(folder: string, options: DevelopmentOptions): Promise<void> {
  let sequence = 0;
  let active = false;
  let queued = false;
  let timer: NodeJS.Timeout | undefined;
  const execute = async (changed?: string) => {
    if (active) {
      queued = true;
      return;
    }
    active = true;
    const started = Date.now();
    try {
      const preview = await runDevelopmentIteration(folder, options);
      console.log(
        JSON.stringify({ event: 'ready', sequence: ++sequence, changed, durationMs: Date.now() - started, preview }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'error',
          sequence: ++sequence,
          changed,
          durationMs: Date.now() - started,
          message: formatDeveloperError(error),
        }),
      );
    } finally {
      active = false;
      if (queued) {
        queued = false;
        void execute('queued changes');
      }
    }
  };
  await execute();
  console.log(JSON.stringify({ event: 'watching', folder }));
  const watcher = watch(folder, { recursive: true }, (_event, fileName) => {
    const changed = fileName?.toString() ?? '';
    if (!changed || ignored(changed)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void execute(relative(process.cwd(), resolve(folder, changed))), 120);
  });
  await new Promise<void>((resolveDone) => {
    const close = () => {
      if (timer) clearTimeout(timer);
      watcher.close();
      resolveDone();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}
