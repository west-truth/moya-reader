import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateMoyaPackageManifest } from '@noveldesk/extension-contracts/package';

/** Copy owned, offline templates only. Never install dependencies, execute hooks or overwrite a project. */
export async function scaffoldProject(folder: string, options: { id: string; name?: string; kind: string }) {
  if (!['text', 'images'].includes(options.kind)) throw new Error('invalid_project_kind');
  const template = options.kind === 'text' ? 'text-catalog' : 'image-catalog';
  const root = new URL(`../../packages/extension-runtime/examples/${template}/`, import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const oldId = manifest.extension.id as string;
  manifest.extension.id = options.id;
  manifest.extension.name = options.name ?? options.id;
  manifest.extension.contributes.externalSources[0].id = options.id + '.source';
  manifest.extension.contributes.externalSources[0].title = options.name ?? options.id;
  const validation = validateMoyaPackageManifest(manifest);
  if (!validation.ok) throw new Error(`${validation.code}:${validation.path}`);
  const files = new Map<string, string>([['manifest.json', JSON.stringify(manifest, null, 2) + '\n']]);
  for (const name of ['src/index.ts', 'content-input.json', 'fixtures.json', 'LICENSE']) {
    files.set(name, (await readFile(new URL(name, root), 'utf8')).replaceAll(oldId, options.id));
  }
  files.set(
    'README.md',
    `# ${manifest.extension.name}\n\nGenerated offline ${options.kind} source example. Replace the synthetic catalog and keep source/work/release IDs stable.\n\nUsing the installed moya-extension command, replace <project> with this folder's absolute path:\n\n\x60\x60\x60sh\nnpx --no-install moya-extension check <project>\nnpx --no-install moya-extension run <project> --method source.getContent --input <project>/content-input.json --fixture <project>/fixtures.json\nnpx --no-install moya-extension dev <project> --method source.getContent --input <project>/content-input.json --fixture <project>/fixtures.json\nnpx --no-install moya-extension preview <project> --method source.getContent --input <project>/content-input.json --fixture <project>/fixtures.json\nnpx --no-install moya-extension pack <project> --out <project>/extension.moyaext\n\x60\x60\x60\n\nNo network request or dependency installation occurs during generation. Run, dev, and preview use offline fixtures unless you explicitly pass --network.\nThe template includes its Apache-2.0 license; review the license and network permissions before publishing your extension.\nFor IDE types, install the separately distributed @moya/extension-sdk tarball. The CLI is distributed separately as @moya/extension-cli.\n`,
  );
  const target = resolve(folder);
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('project_target_exists', { cause: error });
    throw error;
  }
  await mkdir(resolve(target, 'src'));
  for (const [name, content] of files) await writeFile(resolve(target, name), content, { flag: 'wx' });
  return { folder: target, id: options.id, sourceId: options.id + '.source', kind: options.kind };
}
