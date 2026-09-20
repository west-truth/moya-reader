import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);

test(
  'packed CLI installs outside the workspace and executes text and image authoring flows',
  { timeout: 180000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'moya-cli-consumer-'));
    const pkg = fileURLToPath(new URL('./', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const run = (bin, args, cwd = root) => exec(bin, args, { cwd, env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    try {
      await mkdir(join(pkg, 'dist'), { recursive: true });
      await writeFile(join(pkg, 'dist', 'audit-stale.txt'), 'non-secret regression marker');
      await run(process.execPath, [join(pkg, 'build.mjs')]);
      await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}');
      const packed = JSON.parse((await run('npm', ['pack', '--json', '--ignore-scripts', pkg])).stdout)[0];
      assert.ok(
        packed.files.every(
          ({ path }) => !path.includes('node_modules') && !path.includes('.tmp') && !path.includes('audit-stale'),
        ),
      );
      await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename)]);
      // Exercise npm's public bin entry, not a private file path inside the package.
      const cli = async (args) =>
        JSON.parse((await run('npm', ['exec', '--offline', '--no', '--', 'moya-extension', ...args])).stdout);
      const publisher = await cli(['keygen', 'keys']);
      assert.match(publisher.publicKeyFingerprint, /^[a-f0-9]{64}$/);
      await assert.rejects(cli(['keygen', 'keys']), /EEXIST/);
      for (const kind of ['text', 'images']) {
        const id = `org.example.${kind}`;
        assert.equal((await cli(['init', kind, '--id', id, '--kind', kind])).folder, join(root, kind));
        assert.equal((await cli(['check', kind])).valid, true);
        const content = await cli([
          'run',
          kind,
          '--method',
          'source.getContent',
          '--input',
          `${kind}/content-input.json`,
          '--fixture',
          `${kind}/fixtures.json`,
        ]);
        assert.equal(content.result.kind, kind);
        assert.ok(content.assets.length > 0);
        assert.ok(content.assets.every((asset) => asset.byteLength > 0));
        if (kind === 'text') {
          const manifestPath = join(root, kind, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          manifest.preferences = [
            {
              sourceId: `${id}.source`,
              fields: [{ key: 'label', title: 'Label', kind: 'text', secret: false, defaultValue: 'default' }],
            },
          ];
          await writeFile(manifestPath, JSON.stringify(manifest));
          const entry = join(root, kind, 'src/index.ts');
          await writeFile(
            entry,
            (await readFile(entry, 'utf8')).replace(
              'async listWorks({ query, cursor }) {',
              "async listWorks({ query, cursor }, ctx) { await ctx.sleep(1); const response = await ctx.http.request({url:'https://catalog.example/chapter.txt'}); if(response.statusCode !== 200) throw new Error('unexpected_status'); work.title = await ctx.preferences.get('label');",
            ),
          );
          await writeFile(join(root, 'preferences.json'), JSON.stringify({ label: 'Local preferences' }));
          const result = await cli([
            'run',
            kind,
            '--method',
            'source.listWorks',
            '--fixture',
            `${kind}/fixtures.json`,
            '--preferences',
            'preferences.json',
          ]);
          assert.equal(result.result.items[0].title, 'Local preferences');
        }
        const archive = await cli(['pack', kind, '--out', `${kind}/extension.moyaext`, '--key', 'keys/publisher.pem']);
        assert.equal(archive.id, id);
        assert.equal(archive.publisherFingerprint, publisher.publicKeyFingerprint);
        assert.ok((await readFile(archive.output)).length > 0);
        const indexed = await cli([
          'index',
          kind,
          '--url',
          'https://extensions.example/index.json',
          '--out',
          `${kind}/index.json`,
        ]);
        assert.equal(indexed.packages, 1);
        const index = JSON.parse(await readFile(indexed.output, 'utf8'));
        assert.equal(index.packages[0].sha256, archive.digest);
        assert.equal(index.packages[0].id, id);
        await assert.rejects(
          cli(['index', kind, '--url', 'https://extensions.example/index.json', '--out', `${kind}/index.json`]),
          /EEXIST/,
        );
        await assert.rejects(cli(['init', kind, '--id', id]), /project_target_exists/);
        await assert.rejects(cli(['pack', kind, '--out', `${kind}/extension.moyaext`]), /EEXIST/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
