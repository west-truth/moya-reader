# @moya/extension-cli

Node.js 22.12+ authoring tools for Moya JavaScript/TypeScript sources. This package is prepared for tarball distribution; it is not published on npm yet.

Build and pack from a Moya checkout:

```sh
node packages/extension-cli/build.mjs
npm pack --ignore-scripts ./packages/extension-cli
```

An extension author needs only the resulting tarball and Node/npm, not the Moya checkout:

```sh
npm install --save-dev /path/to/moya-extension-cli-0.1.0.tgz
npx moya-extension init my-source --id org.example.catalog --kind text
npx moya-extension check my-source
npx moya-extension run my-source --method source.getContent --input my-source/content-input.json --fixture my-source/fixtures.json
npx moya-extension dev my-source --method source.getContent --input my-source/content-input.json --fixture my-source/fixtures.json
npx moya-extension keygen publisher-keys
npx moya-extension pack my-source --key publisher-keys/publisher.pem --out my-source/extension.moyaext
npx moya-extension index my-source --url https://extensions.example/index.json --out my-source/index.json
```

Use `--kind images` for a comic template. Paths are relative to your current working directory. Existing projects and output archives are never overwritten. Install the separate `@moya/extension-sdk` tarball for editor types.

`init` copies offline examples. `check` validates the manifest and executes the source description in an isolated QuickJS child process. `run` uses explicit fixture responses unless `--network` is supplied; network access remains limited to manifest origins and host policy. It prints metadata and asset byte counts, not downloaded image/text bytes. A source requiring a configured content service cannot use production credentials through this CLI.

`dev` watches the project and repeats the same isolated check after edits. Add `--method`, `--input`, and `--fixture`
for a terminal preview of a source call. It reports build errors with file, line, and column and summarizes large lists;
it never prints downloaded text or image bytes. Stop it with `Ctrl+C`.

No project npm scripts, tsconfig plugins, or arbitrary npm imports are executed during source compilation. Only local modules and the SDK are supported. This is a development tool, not a browser login UI or an installer into the running Moya service.

## Package acceptance test

```sh
node --test packages/extension-cli/build.test.mjs
```

The test builds a real tarball, installs it in a temporary directory without workspace resolution, and exercises both templates through init/check/run/pack and overwrite rejection. npm may fetch the pinned tool/runtime dependencies. The source fixtures themselves make no external requests. Runtime QuickJS/WASM dependencies are shipped as declared npm dependencies, not copied from an application's install.

Moya code is Apache-2.0; third-party dependencies retain their own licenses in the installed packages. Publication to npm or a public repository is a separate release step.

`index` verifies every `.moyaext` in the given directory, calculates SHA-256 and versions from actual bytes, and writes a host-compatible repository index. Keep one current archive per extension ID in that directory. Duplicate IDs, corrupt packages, or a manifest pointing to a different update repository fail without writing the index. Archive URLs refer to the same directory as the public index; publish them together. This command performs no uploads.

`keygen` creates a new P-256 key directory (POSIX 0700, private PEM 0600). Keep the private key outside your public release/source repository and reuse it for updates. `pack --key` uses the existing Moya publisher signature format; omitting it creates an unsigned package. No keys are sent to network services.
