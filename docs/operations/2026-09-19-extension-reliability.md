# Extension reliability acceptance — 2026-09-19

This is an anonymized technical summary of historical tests against two user-selected APK repositories.
Repository addresses, content-site identities, package identifiers and private trace paths are omitted from this
public record. These were real external probes, not synthetic fixtures, and are not a recommended source list.

## Installation and source discovery

The indexes and 16 APKs were downloaded on 2026-09-19 into disposable Docker containers and temporary installation
roots. Production extension inventory, application data and remote state were not changed.

All 16 APKs passed signature verification, manifest/index identity checks, dex conversion, installation, source
discovery, inventory persistence and reopening through `ApkInstallations`. The reopened catalog contained 31 sources
with unique host IDs, including standalone and factory entries that shared a remote source ID.

Of 31 live page-one list requests, 23 succeeded. The eight failures covered four sites, each exposed as a standalone
and factory source. The observed HTTP/socket/network exceptions were distinct from worker bytecode or Android API
compatibility failures. Neither installation success nor this historical sample guarantees current site availability.

## Deeper read probes

- An image source returned a work detail, nine releases and 104 ordered image references. The first image transfer
  failed in the extension network layer; a direct TLS request was also reset. Page discovery succeeded, image transfer did not.
- Another image source returned lists, search and detail, then explicitly required login for releases. No login bypass was attempted.
- A text-content source returned 30 works and 311 releases for the selected work after the worker retained the listed
  URL/title when fresh detail omitted its URL. The extension then constructed `android.webkit.WebView`, with cookies,
  JavaScript and DOM storage. The headless Android shim stopped at the `WebView` constructor with `Stub!`.
  Supporting that path requires a real browser integration. The current contribution contract classified this source
  as an image series, not a text document.

A separate read-only observation of a `.moyaext` cover request found an expired external TLS certificate. This was
independent of the APK WebView failure. The production network also lacked an outbound IPv6 route. Address fallback
may retry read-only `GET`/`HEAD` requests, but does not replay mutations. Those observations were not re-probed or
changed during the isolated APK acceptance run.

## Signature and update checks

- A downloaded v2-signed APK passed `ApkVerifier` at the worker's API-24 verification floor. Requiring API 21 would
  incorrectly demand a v1 JAR signature from valid v2-only APKs. Android's primary documentation confirms that
  [APK Signature Scheme v2 was introduced in Android 7.0/API 24](https://source.android.com/docs/security/features/apksigning/v2)
  and that older platforms require a separate v1 signature.
- A one-byte-modified target APK and a structurally valid unsigned repack both failed with
  `apk_signature_invalid` before any extension class executed.
- Installation tests keep the signer identity across updates and reject a different signer before conversion.
- Failed conversion/description leaves the prior version active, and lower/equal versions are rejected.
- Updating a disabled package now preserves `enabled: false`; a regression test covers this behavior.
- Extension API versions with major `1` and minor `3` through `6` are accepted, including build suffixes. The requested
  live 1.4 and 1.6 APKs both installed and ran. Later API minors fail review with
  `apk_android_feature_unsupported`.

## Pinned runtime and remaining limits

The worker build remains pinned to Suwayomi Server `v2.3.2243` and source archive SHA-256
`e70f664013e83d49fee66ab5f83b6f281d956560c5a8baeba1d00b417048efb2` in
[`services/apk-worker/build.py`](../../services/apk-worker/build.py). Dependency hashes remain locked in
[`services/apk-worker/dependencies.lock.json`](../../services/apk-worker/dependencies.lock.json), including apksig
8.10.1 and dex2jar 2.4.37. The API compatibility bound follows the pinned upstream
[`PackageTools.kt`](https://github.com/Suwayomi/Suwayomi-Server/blob/v2.3.2243/server/src/main/kotlin/suwayomi/tachidesk/manga/impl/util/PackageTools.kt),
which declares extension library versions 1.3 through 1.6. Acceptance used Temurin JDK 21 in Docker.

The runtime supports Tachiyomi/Mihon manga APIs and Aniyomi manga factories, including external generated entry-class
names. It does not implement Android WebView, interactive browser challenges, arbitrary Android services/UI, or video
APIs. Site availability, TLS certificates, CDN routing, bot challenges, login state, and extension parser drift remain
external to APK installation compatibility. The operational boundary and trust model are described in
[`services/apk-worker/README.md`](../../services/apk-worker/README.md).

Validation completed for this change:

- 29 Node worker tests passed, including update signer, rollback, disabled-update, catalog, cancellation, and deadline
  behavior.
- Five isolated Java smoke programs passed: Android dispatcher, network session, preferences, filter mapping, and
  uninitialized detail identity fallback.
- All 16 requested live APKs passed inspect/convert/install/reopen/source-discovery; 23/31 live list probes succeeded.

The APKs and private debug traces remain outside the repository. The network-free checks can be repeated with:

```sh
node --test services/apk-worker/*.test.mjs
docker run --rm --network none -v "$PWD:/repo:ro" -w /repo eclipse-temurin:21-jdk \
  sh -lc 'for test in AndroidDispatcherSmoke NetworkSessionSmoke PreferencesSmoke FiltersSmoke MangaDetailsSmoke; do java -cp "services/apk-worker/build/target/apk-worker-0.1.0.jar:services/apk-worker/build/dependencies/*" "services/apk-worker/test/$test.java" || exit; done'
```
