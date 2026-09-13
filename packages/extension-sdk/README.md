# Moya extension SDK

Write text and image source extensions in ordinary JavaScript or TypeScript. This package contains the same
`defineExtension`, `defineSource`, `providerText`, and source types used by Moya's existing extension builder.
It has no runtime dependencies and does not require a Moya checkout in the consuming project.

The package is not published to npm yet. Maintainers build a distributable archive with:

```sh
corepack pnpm --filter @moya/extension-sdk pack --pack-destination .tmp/extension-sdk
```

An extension author installs the resulting archive in their own project:

```sh
npm install --save-dev /path/to/moya-extension-sdk-0.1.0.tgz
```

```ts
import { defineExtension, defineSource } from '@moya/extension-sdk';

export default defineExtension({
  sources: [
    defineSource({
      id: 'org.example.source',
      async listWorks() {
        return { items: [{ id: 'book', title: 'Example' }] };
      },
      async getWork({ workId }) {
        return { id: workId, title: 'Example' };
      },
      async listReleases() {
        return { items: [{ id: 'chapter', title: 'Chapter 1', order: 1 }] };
      },
      async getContent(_input, context) {
        return { kind: 'text', asset: await context.textAsset('Example text\n') };
      },
    }),
  ],
});
```

The SDK supplies types and host-call wrappers. It does not grant network access, store credentials, or start an
authentication server. Sources that need an external content service use the optional host contract; existing
third-party APK/JS extensions retain their own protocol. No extra Moya password or key is created by this SDK.

The installation archive remains `.moyaext` (ZIP with manifest, JS, and notices). The existing Moya `check/run/pack`
CLI still lives in the main repository and injects its bundled SDK; a standalone authoring CLI is a separate next step.
Use the matching SDK/tool version when packaging. Runtime permissions and result validation remain host-owned.

# Browser execution and source options

Source-defined options are declared in the package manifest and read with `context.preferences.get(key)`.
`context.webview.evaluate({url, script})` runs site JavaScript in a host browser when the package declares
`requestedAccess.webview: true`. `context.http.request` returns HTTP status, headers and body for an extension's
own optional service protocols; Moya does not require a particular authentication server. `context.sleep(ms)`
provides a cancellable polling delay.

The browser uses the package's network grants and isolated persisted session. Browser execution is not a network
filter bypass, and unsupported Android APIs remain a separate APK compatibility issue.
