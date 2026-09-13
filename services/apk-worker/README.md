# Minimal manga APK worker

Source-built compatibility runtime for Tachiyomi/Mihon-compatible manga APKs, including Aniyomi manga factories.
No Suwayomi HTTP server, GraphQL, database, download queue or WebUI is bundled.

Current checkpoint: settings UI, persistent multi-repository management, Hosted/native APIs and the existing CBZ import
path are connected. Docker and Windows sidecar packages include Java; end users do not need a separate Java installation.
Android/WebView compatibility remains partial. See [verified scope](../../docs/project/0913-apk-worker-implementation.md).

## Developer build

Requires Python 3, JDK 21 and Maven 3.9. Use a configured `JAVA_HOME` and run:

```sh
python services/apk-worker/build.py --maven /path/to/mvn
node --test services/apk-worker/*.test.mjs
```

`--source-archive /path/to/cache.zip` avoids another source download; the SHA-256 check still applies. The build fetches
a pinned source archive and Maven dependencies, compiles selected source/model/network APIs and Android preference
classes, and emits an inventory in `build/`. Generated code, JARs and runtime data are ignored.

Upstream selected files retain their MPL-2.0 or Apache-2.0 source headers. `build/UPSTREAM-LICENSE` is the upstream
MPL-2.0 license. The generated source tree and build recipe must accompany any binary distribution as required by
their licenses. The rest of Moya is not relicensed. Dependency hashes are locked; a complete third-party notice review
is still release work. An npm-only license check does not cover these JARs.

After the worker build, `node scripts/extensions/bundle-native.mjs` packages the Windows x64 sidecar and a digest-pinned
Temurin 21 JRE, including its legal files. `MOYA_APK_JRE_ARCHIVE` may point at a cached official archive (hash checked).
`deploy/server.Dockerfile` builds from source and includes a Linux JRE. Hosted development can set `MOYA_APK_RUNTIME_DIR`
and `MOYA_APK_JAVA`; otherwise the local build and JAVA_HOME are used. APK inventory/state belongs to the server owner
or native app data directory, separate from library backups. A static browser alone cannot execute APKs.

## Boundaries

- `Inspect` verifies the APK signature and parses the Android manifest without executing its classes. APKs must declare
  the manga API. A SourceFactory may provide multiple sources; names containing “novel” are allowed because some sources
  return novel pages as images. Video APIs are outside this worker.
- `ApkInstallations` separates review from activation, pins signer identities, rejects downgrade/mismatched index entries,
  and switches the inventory only after conversion and source enumeration succeed. Interrupted/failed activation retains
  the previous package. Original APKs, preferences, reference maps and prior artifacts remain host-private.
- `ApkWorkerSupervisor` serializes each installation's commands, bounds admission/output/time, kills stuck/cancelled
  processes and starts subsequent work afresh. It never silently replays a failed network operation. Workers remain
  available for 10 minutes after the last completed request, then exit. Each catalog retains at most two workers;
  starting another installation may evict an idle worker sooner. Active requests have no idle timer. Cancellation,
  settings changes, disabling/removal and host shutdown still terminate workers immediately.
- `ApkSourceCatalog` owns remote URL references, 64-bit source IDs, chronological chapter pages and binary image assets.
  The common source contract is intended to feed the existing CBZ importer and series queue, not another reader.
- APKs are native JVM code, not restricted JavaScript guests. A separate process, cleared environment and heap limit are
  reliability measures, **not an arbitrary-code security sandbox**. Installation requires explicit trust review.
  This runtime is for trusted APKs; it must not be offered as a safe executor for arbitrary uploads on a public service.
  Strong OS/network isolation remains required for that deployment model.
- WebView, Android main-thread services, arbitrary Android UI, full extension preferences UI and challenge handling remain
  incomplete. A bounded headless Looper/Handler now supports FIFO/delayed messages and cancellation; it is not a WebView.
  Process-scoped HTTP cookies preserve ordinary sessions without sharing browser credentials. They expire on worker exit.
  Source enumeration does not initialize each site's network/WebView state or prove every source usable.
  A small compatibility host intentionally fails unsupported Android services; it does not pretend to bypass them.

The opt-in Java `-Dmoya.apk.debug=true` switch prints private diagnostics to stderr. Do not enable it in normal hosts
or publish the resulting URLs/content. The normal supervisor discards extension stderr and exposes only safe codes.

The build runs three network-free Java source-launcher tests for dispatcher timing/cancellation, cookie isolation,
and original preference mapping/encrypted persistence/transaction rollback.
Live evidence (2026-09-13): 5 of 15 factory sources returned a catalog in this network environment; 10 failed requests.
One diagnosed failure originated as an IOException inside the APK's network layer. A public source's full 143-page
chapter produced a 20,557,657-byte CBZ in 10.5 seconds and was imported/displayed by the production mobile reader.
These results do not establish all-source, authentication, WebView, or final installer compatibility.

## Original source options

Hosted and native APK management expose `ConfigurableSource` text, toggle and list preferences grouped by source.
Original disabled/visible states and change callbacks are respected; unsupported Android windows/actions are not
executed. Enabling a source's optional server may require saving the toggle before its address fields become enabled.
Only extension-defined keys can be changed. Password/key fields are redacted in responses and unchanged secrets are
retained. Saving options does not report chapter authentication success.

`preferences.enc` uses AES-GCM with an automatically generated per-installation `preferences.key`; there is no extra
application password. Both files belong in the host-private data directory. This is not an OS keychain or APK sandbox.
Legacy hashed JSON namespaces migrate on the next successful write. Rejected preference callbacks roll back the
entire local preference transaction. Updates retain state; removal/reinstall allocates a new namespace. Orphan state
cleanup remains future work. Settings changes invalidate workers and reference caches without changing library IDs.

Page discovery may include an extension-owned authentication job: only `pages` receives a 150s guest/165s process
deadline; ordinary calls retain their shorter limits. Host/native content transfers allow 210s. Cancellation kills
the worker and does not replay operations; remote job cleanup on forced termination depends on upstream expiration.
Windows JSON stdout is explicitly UTF-8. See the implementation document for isolated original-APK job evidence;
synthetic provider responses are not proof of real logged-in site access.
