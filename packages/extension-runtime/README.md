# Extension execution boundary

Status: isolated engine and Hosted package execution are integrated. Managed native distribution remains.

This package runs a bundled JavaScript source in a new QuickJS WebAssembly instance inside a fresh Node helper
process. The guest does not run in Node's realm. It has no module loader, filesystem, network, browser storage,
environment or Tauri objects. Only JSON calls to explicitly supplied broker methods can cross the boundary.

The internal spike entrypoint is `globalThis.moyaExtension = async (method, input, host) => result`.
`host.request(method, input)` calls a host-granted broker. The source SDK and `.moyaext` developer tools compile to this internal entrypoint.
The host must bind brokers to verified package permissions and connection scope before production activation.

```sh
corepack pnpm --filter @moya/extension-runtime test
```

Each invocation has a 32 MiB guest heap, 512 KiB stack, five-second execution deadline, 1 MiB JSON payload ceiling,
64 total and four concurrent broker calls by default. The parent owns cancellation, hard timeout and child termination.
Raw guest exceptions and helper stderr are not exposed to consumers. Child environment excludes application secrets.
Native/WASM defects are not ruled out by these limits; application brokers remain a separate authority boundary.

Current dependency choice is QuickJS Emscripten core + the release-sync WASM variant at 0.32.0. Async guest promises
are pumped in bounded batches; asyncify/debug variants are not shipped. Code is source text, not engine-specific bytecode.

Windows x64 Node 22.21.0 and Linux x64 Node 22.21.0 (WSL) passed the focused tests. Linux uses the official Node
distribution checked against its published SHA-256 list. This does not prove desktop installer or Docker deployment.
The current development host uses `process.execPath`; desktop packaging must supply its own managed runtime before
claiming installation without a system Node dependency. Native packaging remains; Hosted includes this production dependency without a separate Node installation.

The host admits at most two child processes, with sixteen queued requests and a fifteen-second queue deadline.
Queued cancellation removes the request; running cancellation keeps its process slot until the child actually closes.
`src/extensions/packages/package-runtime-catalog.ts` adds package generation fencing behind a platform execution port.
Its Source Hub adapter has integration tests through the existing text assembler and comic download format, but is
now wired to the application composition root and Hosted execution port. Native execution remains separate.

`source-http.mjs` restricts requests to explicitly granted HTTPS origins, validates every DNS answer and pins the
connection address, and rechecks redirects. Private/loopback/link-local addresses and caller-supplied credentials
are rejected. This public-source broker is separate from future host-managed authenticated connections.
`source-broker.mjs` holds binary responses outside guest JSON and returns scoped, single-consumption asset handles.
Limits are 256 KiB for metadata/text parsing, 16 MiB per asset and 32 MiB total in-flight/stored bytes per invocation.
Text synthesized by a guest is UTF-8; downloaded assets preserve bytes. Body cancellation releases streams.
Authentication/rate errors cross the boundary as fixed codes, never upstream bodies or arbitrary guest messages.
Compressed HTTP responses are currently rejected (requests ask for identity encoding).
