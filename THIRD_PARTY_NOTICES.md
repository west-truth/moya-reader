# Third-party notices

Moya source code is distributed under the Apache License 2.0; see `LICENSE`. Moya also includes
third-party software under separate terms. This notice records the archive backends used by the web and hosted
deployment, but it does not replace the license texts under `third_party/licenses/` or the generated production
dependency inventory at `third_party/production-license-inventory.json`.

## Optional local TTS sidecar

### MeloTTS / MeloTTS-Korean

- Purpose: optional Korean CPU TTS service started through `compose.local-tts.yaml`.
- Source: <https://github.com/myshell-ai/MeloTTS>, pinned by the `MELOTTS_COMMIT` build argument.
- Model: <https://huggingface.co/myshell-ai/MeloTTS-Korean>, downloaded at first service start into a named volume.
- License: MIT for the MeloTTS repository and the published Korean model card.
- Distribution boundary: the default Moya web/server images do not contain MeloTTS source or weights. The optional
  Docker image is built separately by the operator and downloads the model at first start.

## Archive backends

### 7z-wasm 1.2.0

- Purpose: encrypted 7z/CB7 fallback.
- Source: <https://github.com/use-strict/7z-wasm>
- Bundled output: `7zz.wasm`, based on 7-Zip 24.09.
- License: GNU LGPL 2.1 or later plus the unRAR restriction for `7zz.*.js` and `7zz.wasm`.
- Included texts: `third_party/licenses/7z-wasm/License.txt` and
  `third_party/licenses/common/unRarLicense.txt`. The complete pinned official LGPL 2.1 text is included at
  `third_party/licenses/common/LGPL-2.1.txt`.

### node-unrar-js 2.0.2

- Purpose: local single-volume RAR4/RAR5/CBR extraction.
- Source: <https://github.com/YuJianrong/node-unrar.js>
- Bundled output: UnRAR WebAssembly built from the official UnRAR source (the pinned package build script identifies
  UnRAR 6.1.7).
- License: MIT for the JavaScript/TypeScript wrapper; the embedded UnRAR code is subject to the unRAR restriction.
- Included texts: `third_party/licenses/node-unrar-js/LICENSE.md` and
  `third_party/licenses/common/unRarLicense.txt`.

### libarchive-wasm 1.2.0

- Purpose: ordinary local 7z/CB7 manifest and page extraction.
- Source: <https://github.com/ofk/libarchive-wasm>
- Runtime version reported by the bundled binary: libarchive 3.7.7, zlib 1.3.1, liblzma 5.6.4 and bzip2 1.0.8.
- Package metadata license: MIT for the wrapper. libarchive is BSD-2-Clause; its compiled compression dependencies keep
  their respective upstream licenses.
- Source origins: <https://github.com/libarchive/libarchive>, <https://zlib.net/>, <https://tukaani.org/xz/> and
  <https://sourceware.org/bzip2/>.
- The npm tarball does not contain a standalone license file. A public release must capture the exact upstream license
  texts/corresponding source for the emitted binary before this backend's redistribution gate is considered closed.

## Release requirements still open

- Decide how corresponding source/relinking information for `7zz.wasm` is delivered with binary web/container
  releases. The full pinned official GNU LGPL 2.1 text is already packaged.
- Complete the libarchive 3.7.7 and compiled codec license/source capture described above.
- Complete the container base-image and optional local-TTS Python dependency inventory before publishing official
  prebuilt images.
- Verify `LICENSE`, this notice, and bundled third-party license files in every official binary release artifact.

`pnpm licenses:generate` refreshes the path-free, deterministic pnpm production inventory.
`pnpm check:licenses:source-release` verifies the source-release license boundary. `pnpm check:licenses:release`
intentionally remains blocked until the binary redistribution items in `third_party/license-release-policy.json` are
resolved. Passing either automated inventory check is not legal approval.

This inventory records engineering provenance and is not legal advice.
