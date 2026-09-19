# Extension reliability acceptance — 2026-09-19

This record covers the two repositories requested for acceptance:

- `https://dc-toki-suwayomi.pages.dev/index.min.json` — 15 APKs and 16 sources
- `https://dc-toki-aniyomi-manga.pages.dev/index.min.json` — one APK and 15 sources

The indexes and all 16 APKs were downloaded on 2026-09-19. Tests ran in disposable Docker containers and temporary
installation roots. No production extension inventory, application data, or remote state was changed. All APKs had the
same verified certificate SHA-256, `7762e5f981805968f73bab8c5289915f706beb319cce1bd3f5930bcf5aa79a2e`.

## Installation and source discovery

All 16 APKs passed APK signature verification, manifest/index identity checks, dex conversion, installation, source
discovery, inventory persistence, and reopening through `ApkInstallations`. The reopened catalog contained 31 sources
with 31 unique host IDs. In particular, the standalone and factory Naver entries share remote source ID
`3553407558613814216`, but remained distinct as
`moya.apk.f1d3b11005747cab804eee13.3553407558613814216` and
`moya.apk.35cc177cfd88005808280731.3553407558613814216`.

`List` means a live page-one popular-list request after reopening. An error here does not undo the install result; it
records what the upstream site and this test network returned at the acceptance time.

| Package                                                  | Version | APK SHA-256                                                        | Discovered | Live list result                                                                                    |
| -------------------------------------------------------- | ------- | ------------------------------------------------------------------ | ---------: | --------------------------------------------------------------------------------------------------- |
| `eu.kanade.tachiyomi.extension.ko.sbxhnovelsuwayomitest` | 1.4.12  | `39647e9dd8eb4016fa4b286aab91d297c1752a16222cc7d0dbdc8d4835b5c6be` |          1 | 30 works                                                                                            |
| `eu.kanade.tachiyomi.extension.ko.ntk`                   | 1.4.57  | `34d54d20bd429ff1277ab345552568d14e4dd50d777e78b01e71668e3507e3f6` |          1 | 96 works                                                                                            |
| `eu.kanade.tachiyomi.extension.ko.ntkmangatest`          | 1.4.60  | `e5810cd6ac9a6db7fa21684c040656c80d8d0a71b814631da0bdb28545c270ce` |          1 | 49 works                                                                                            |
| `eu.kanade.tachiyomi.extension.ko.dctokiwebtoon`         | 1.4.30  | `a22d6ba36936627f14b521b8c116a3e71c424dade8725ee231ec2d21fa6f127f` |          1 | 42 works                                                                                            |
| `eu.kanade.tachiyomi.extension.ko.dctokimanga`           | 1.6.57  | `4993bc0b4327583bb5db0fa4c013a3d97bcff73346bc8cd257793cf21d1ab0dc` |          1 | 42 works                                                                                            |
| `eu.kanade.tachiyomi.extension.ko.blacktoon`             | 1.4.30  | `9eb8a507254c760b54e4221219eccac9312c40697d11f9cfe073834b7664dfec` |          1 | Network/site failure: first-party data request returned HTTP 403; socket fallbacks also failed      |
| `eu.kanade.tachiyomi.extension.ko.jjaptoon`              | 1.4.16  | `04d8fcde5e703e41ace7c320b944f9447068b461e158297d07f0ad92b428873d` |          1 | Network failure: unreachable/reset connection attempts                                              |
| `eu.kanade.tachiyomi.extension.ko.sbxhwebtoon`           | 1.4.29  | `85923e4b620f80794614e5c18e4fd542fe7fc71e39fcb0599290eca1c3e21cc9` |          1 | 42 works                                                                                            |
| `eu.kanade.tachiyomi.extension.ko.sbxhmanga`             | 1.6.47  | `cd1b926677000615b180cfdd94b3b8c752bd0b75bf5e0e5f7b80cbf3cc097cb1` |          1 | 42 works                                                                                            |
| `eu.kanade.tachiyomi.extension.ko.toon11`                | 1.4.27  | `fdbbf43f349971aca2987ead6e3c794db59435c85bdd9e13c15c5e09b4df9e1b` |          1 | Network failure: connection reset                                                                   |
| `eu.kanade.tachiyomi.extension.ko.wfwfv1`                | 1.4.21  | `f43a9c2cbf12b53ab839da71f0fc9f2d590a6cb07f79cc55ec051e47015efd8b` |          2 | 36 works from each source                                                                           |
| `eu.kanade.tachiyomi.extension.ko.dcnaverwebtoon`        | 1.4.13  | `cecc5ba282994e280fe2ea5fbf2e35e7eee09430f8f64d404e76cbdec8357f98` |          1 | 128 works                                                                                           |
| `eu.kanade.tachiyomi.extension.ko.tokkisignal`           | 1.4.10  | `675809f82726b7a1a094f85e480db8901ce4ce20fb60b00c14e9fc1332397176` |          1 | 15 status entries                                                                                   |
| `eu.kanade.tachiyomi.extension.ko.goodtoonwebtoontest`   | 1.4.2   | `d84d60b7e90dc5b9545880731e1577a2bbf866c77b5e7f1ab24c5db4acab8f64` |          1 | 63 works                                                                                            |
| `eu.kanade.tachiyomi.extension.ko.xtoonwebtoon`          | 1.4.4   | `75ec2ad3e1bbf8d08448d11c01c403ad4459d0b7409ceced2e867da5503fbfee` |          1 | Network failure: unreachable/reset connection attempts                                              |
| `eu.kanade.tachiyomi.extension.ko.dcmanga`               | 1.4.6   | `8caea537ba54845fc80dc72435ee04752ace6109704f0000f4ed0d9343da94cd` |         15 | 11 lists succeeded; Blacktoon, Jjaptoon, 11toon, and xtoon repeated the standalone network failures |

The result was 23 successful live list requests out of 31 source instances. The eight failures are the same four sites
appearing once as standalone APKs and once in the Aniyomi factory. Debug runs ended in HTTP/socket/network exceptions,
not `LinkageError`, `VerifyError`, or unsupported Android API errors. This distinguishes the observed failures from a
worker bytecode/API compatibility failure, while avoiding a claim that those sites are universally unavailable.

## Deeper read probes

- **Newtoki webtoon:** live list, detail, nine releases, and page discovery succeeded. The selected release returned 104
  ordered image references. Fetching the first image then failed in the extension network layer against
  `aws-cdn9.site`; a direct TLS request from the same environment was reset as well. This proves page discovery, but not
  a successful image transfer in this environment.
- **Naver webtoon:** live popular list, exact-title search, and detail succeeded. Release discovery returned the
  extension's explicit `네이버 로그인 필요 · 앱에서는 열람 불가` sentinel. Page discovery therefore failed without
  attempting to bypass login.
- **SBXH novel:** live list returned 30 works. Detail and 311 releases succeeded for work `/novel/57318` after the worker
  retained the listed URL/title when the extension returned a fresh `SManga` with an uninitialized URL. Page discovery
  then reached the extension's own browser-only path. Decompilation of that path shows construction of
  `android.webkit.WebView`, JavaScript and DOM storage enablement, a `CookieManager`, JavaScript bridge, WebView client,
  and `loadUrl`. The headless compatibility layer stops at the `WebView` constructor with Android's `Stub!`. Supporting
  this source's novel body requires a real browser/WebView integration and is outside this worker's bounded Android
  shim. The source is an image-series contribution in the current contract; it is not a text-document source.

An APK being installable or able to enumerate sources is therefore not recorded as end-to-end reading success.

## Related production observation outside the APK matrix

Earlier read-only production evidence for the separate `private.novel.catalog` `.moyaext` extension version 1.2.0 is
kept separate from the APK results above. Its work 57318 cover request used `aws-cdn1.site`, whose certificate expired
on 2026-09-17. That external TLS failure is independent of the APK's SBXH page failure at the local WebView constructor.
The production network also had no outbound IPv6 route. The source HTTP fallback may retry read-only `GET` and `HEAD`
requests through another resolved address; it does not replay `POST` or other mutating requests. These observations were
not re-probed or changed during this isolated APK acceptance run.

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

The sanitized machine-readable evidence from this run is in the temporary acceptance root recorded by
`/tmp/moya-apk-acceptance.path`. The principal reports are `matrix-result.json` (all 16 package/APK/source-JAR digests
and 31 list outcomes), `install-result.json` (reopen/collision and deeper Naver probes), `sbxh-after-fix.jsonl`, and
`newtoki-pages.jsonl`. The APKs and private debug traces remain outside the repository. The network-free checks can be
repeated with:

```sh
node --test services/apk-worker/*.test.mjs
docker run --rm --network none -v "$PWD:/repo:ro" -w /repo eclipse-temurin:21-jdk \
  sh -lc 'for test in AndroidDispatcherSmoke NetworkSessionSmoke PreferencesSmoke FiltersSmoke MangaDetailsSmoke; do java -cp "services/apk-worker/build/target/apk-worker-0.1.0.jar:services/apk-worker/build/dependencies/*" "services/apk-worker/test/$test.java" || exit; done'
```
