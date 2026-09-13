import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { SourceContent, SourceAsset } from '@noveldesk/extension-contracts/source-sdk';
import { MOYA_PACKAGE_LIMITS, validateMoyaPackageManifest } from '@noveldesk/extension-contracts/package';
import {
  SOURCE_METHODS,
  validateSourceInput,
  validateSourceResult,
  validateSourceContentRequest,
  type SourceMethod,
} from '@noveldesk/extension-contracts/source-protocol';
import { buildMoyaExtension } from '../../src/extensions/packages/package-builder';
import { verifyMoyaExtension, type VerifiedMoyaPackage } from '../../src/extensions/packages/package-archive';
import { runExtension } from '../../packages/extension-runtime/host.mjs';
import { createSourceBroker } from '../../packages/extension-runtime/source-broker.mjs';
import { createSourceStateSession, type SourceStateValues } from '../../src/extensions/packages/source-state';
import {
  materializeSourceContent,
  type SourceContentResolver,
} from '../../apps/server/src/extensions/source-content-service';

// Reuse the workspace's pinned build tool; do not install dependencies or execute project configuration/scripts.
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { build } = require('esbuild') as typeof import('../../apps/server/node_modules/esbuild');
const sdkPath = fileURLToPath(new URL('../../packages/extension-contracts/source-sdk.ts', import.meta.url));

export async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximum) throw new Error('project_file_limit');
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error('project_file_limit');
  return bytes;
}

export async function buildProject(folder: string): Promise<VerifiedMoyaPackage> {
  const root = await realpath(folder);
  const localFile = async (path: string) => {
    const canonical = await realpath(path);
    const rel = relative(root, canonical);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('project_path_denied');
    return canonical;
  };
  const manifestBytes = await boundedFile(
    await localFile(resolve(root, 'manifest.json')),
    MOYA_PACKAGE_LIMITS.manifestBytes,
  );
  const validation = validateMoyaPackageManifest(JSON.parse(manifestBytes.toString('utf8')));
  if (!validation.ok) throw new Error(`${validation.code}:${validation.path}`);
  const manifest = validation.manifest;
  if (manifest.extension.contributes?.bookEnrichmentProviders?.length)
    throw new Error('unsupported_development_capability');
  let moduleCount = 0;
  let moduleBytes = 0;
  const output = await build({
    stdin: {
      contents: `import extension from './src/index'; globalThis.moyaExtension = extension;`,
      resolveDir: root,
      sourcefile: 'moya-entry.js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    target: 'es2020',
    sourcemap: false,
    logLevel: 'silent',
    legalComments: 'inline',
    // Ignore package tsconfig aliases and imported build plugins: only explicit local modules and the SDK are allowed.
    tsconfigRaw: {},
    plugins: [
      {
        name: 'moya-local-modules',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async (args) => {
            if (args.path === '@moya/extension-sdk') return { path: sdkPath, namespace: 'moya-sdk' };
            if (args.kind !== 'import-statement' || !args.path.startsWith('.'))
              throw new Error('project_import_denied');
            const base = resolve(args.resolveDir, args.path);
            for (const suffix of ['', '.ts', '.js', '.mjs', '.json', '/index.ts', '/index.js']) {
              try {
                const path = await localFile(base + suffix);
                if ((await stat(path)).isFile()) return { path };
              } catch (error) {
                if ((error as Error).message === 'project_path_denied') throw error;
              }
            }
            throw new Error('project_import_missing');
          });
          builder.onLoad({ filter: /.*/, namespace: 'moya-sdk' }, async () => ({
            contents: await readFile(sdkPath, 'utf8'),
            loader: 'ts',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
            if (++moduleCount > 256) throw new Error('project_module_limit');
            const contents = await boundedFile(args.path, MOYA_PACKAGE_LIMITS.entryBytes);
            moduleBytes += contents.length;
            if (moduleBytes > MOYA_PACKAGE_LIMITS.expandedBytes) throw new Error('project_module_limit');
            const loader = args.path.endsWith('.json') ? 'json' : args.path.endsWith('.ts') ? 'ts' : 'js';
            return { contents, loader, resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  const license = (await boundedFile(await localFile(resolve(root, 'LICENSE')), 256 * 1024)).toString('utf8');
  const notices = `Bundled Moya source SDK — Apache-2.0\n\n${await readFile(new URL('../../LICENSE', import.meta.url), 'utf8')}`;
  const archive = await buildMoyaExtension({ manifest, source: output.outputFiles[0].text, license, notices });
  return verifyMoyaExtension(archive);
}

export async function checkProjectPackage(pkg: VerifiedMoyaPackage, signal?: AbortSignal): Promise<void> {
  const result = (await runExtension({ source: pkg.source, method: 'describe', signal })) as {
    apiVersion?: number;
    sources?: { id: string; cover: boolean }[];
  } | null;
  const declared = pkg.manifest.extension.contributes?.externalSources ?? [];
  if (
    !result ||
    result.apiVersion !== 1 ||
    !Array.isArray(result.sources) ||
    result.sources.length !== declared.length ||
    !declared.every(
      (source) =>
        result.sources!.filter((item) => item?.id === source.id && typeof item.cover === 'boolean').length === 1,
    )
  )
    throw new Error('source_manifest_mismatch');
  for (const descriptor of declared) {
    if (
      descriptor.schemaVersion !== 2 ||
      descriptor.kind !== 'catalog' ||
      !descriptor.seriesProfile ||
      !descriptor.capabilities.includes('release-list') ||
      !descriptor.capabilities.includes('release-download') ||
      (descriptor.capabilities.includes('cover-read') &&
        !result.sources.find((item) => item.id === descriptor.id)?.cover)
    )
      throw new Error('unsupported_source_capability');
  }
}

export interface DevelopmentFixture {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly status?: number;
  readonly body?: string;
  readonly bodyBase64?: string;
  readonly contentType?: string;
}

export async function runProjectSource(
  pkg: VerifiedMoyaPackage,
  method: SourceMethod,
  input: unknown,
  options: {
    network?: boolean;
    fixtures?: readonly DevelopmentFixture[];
    signal?: AbortSignal;
    state?: SourceStateValues;
    /** Explicit test/development injection. CLI never reads production provider settings. */
    contentResolver?: SourceContentResolver;
  } = {},
) {
  if (
    !SOURCE_METHODS.includes(method) ||
    !validateSourceInput(method, input) ||
    !pkg.manifest.extension.contributes?.externalSources?.some((source) => source.id === input.sourceId)
  )
    throw new Error('invalid_source_invocation');
  const { Readable } = await import('node:stream');
  const transport = options.network
    ? undefined
    : {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async ({ url }: { url: URL }, request: { method: string }) => {
          const fixture = options.fixtures?.find(
            (item) => item.url === url.href && (item.method ?? 'GET') === request.method,
          );
          if (!fixture) throw new Error('fixture_missing');
          return {
            status: fixture.status ?? 200,
            headers: { 'content-type': fixture.contentType ?? 'text/plain' },
            body: Readable.from([
              fixture.bodyBase64 !== undefined
                ? Buffer.from(fixture.bodyBase64, 'base64')
                : Buffer.from(fixture.body ?? ''),
            ]),
          };
        },
      };
  const broker = createSourceBroker(
    {
      origins: pkg.manifest.requestedAccess.networkOrigins,
      allowDownloads: pkg.manifest.extension.permissions.includes('external.source.download'),
    },
    transport,
  );
  try {
    const storage = createSourceStateSession(options.state, pkg.manifest.requestedAccess.storageKiB);
    const value: unknown = await runExtension({
      source: pkg.source,
      method,
      input,
      broker: { ...broker.methods, ...storage.methods },
      signal: options.signal,
      timeoutMs: 30000,
    });
    if (method === 'source.getContent' && validateSourceContentRequest(value)) {
      broker.dispose();
      const response = await materializeSourceContent(
        pkg,
        String(input.sourceId),
        value,
        options.signal ?? new AbortController().signal,
        options.contentResolver,
      );
      return {
        result: response.result,
        stateChanges: storage.changes(),
        assets: await Promise.all(
          [...response.assets].map(async ([handle, blob]) => ({
            handle,
            bytes: Buffer.from(await blob.arrayBuffer()),
            contentType: blob.type,
          })),
        ),
      };
    }
    if (!validateSourceResult(method, value)) throw new Error('invalid_source_result');
    const content = method === 'source.getContent' ? (value as SourceContent) : undefined;
    const descriptor = pkg.manifest.extension.contributes!.externalSources!.find(
      (source) => source.id === input.sourceId,
    )!;
    if (
      content &&
      descriptor.schemaVersion === 2 &&
      (descriptor.seriesProfile?.kind === 'document_series' ? content.kind !== 'text' : content.kind !== 'images')
    )
      throw new Error('source_content_profile_mismatch');
    const refs = content
      ? content.kind === 'text'
        ? [content.asset]
        : content.assets
      : method === 'source.getCover' && value
        ? [value as SourceAsset]
        : [];
    const assets = refs.map((ref) => {
      const asset = broker.takeAsset(ref.handle) as { bytes: Buffer; contentType: string };
      if (
        asset.bytes.length !== ref.byteLength ||
        asset.contentType !== ref.contentType ||
        createHash('sha256').update(asset.bytes).digest('hex') !== ref.sha256
      )
        throw new Error('invalid_source_asset');
      return { ...asset, handle: ref.handle };
    });
    return { result: value, assets, stateChanges: storage.changes() };
  } finally {
    broker.dispose();
  }
}
