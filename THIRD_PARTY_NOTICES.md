# Third-party notices

Moya source code is distributed under the Apache License 2.0; see `LICENSE`. Moya also includes
third-party software under separate terms. This notice records the archive backends used by the web and hosted
deployment, but it does not replace the license texts under `third_party/licenses/` or the generated production
dependency inventory at `third_party/production-license-inventory.json`.

## Bundled Desktop metadata collector

The optional `웹소설 표지·작품 정보` trusted extension is packaged in Desktop releases as a Python/PyInstaller
sidecar. Its direct runtime/build dependencies include Python, FastAPI, Uvicorn, HTTPX, Beautiful Soup, lxml,
Playwright, Pydantic and PyInstaller. These projects use their own PSF, MIT, BSD, Apache-2.0 and PyInstaller
bootloader-exception terms. The generated executable is not committed to this source repository.

`pnpm collector:bundle` creates an isolated Python environment and emits the exact 37-component inventory at
`src-tauri/collector-sidecar/python-license-inventory.json`. It also copies each component's detected license texts,
the Moya collector license and the Python runtime license under the packaged `collector-sidecar/third_party/licenses/`
resource. The build fails when a component is unclassified or has no copied license file. This inventory is generated
for the Desktop sidecar and is separate from the pnpm production inventory.

The optional `compose.metadata-collector.yaml` image installs the collector's public metadata runtime without the
Playwright authentication or PyInstaller build extras. It is built from source by the self-host operator and includes
this notice and the project license. Publishing an official prebuilt collector container still requires an inventory
for its exact Python base image and installed runtime distributions.

The separate `compose.metadata-collector-auth.yaml` profile replaces that service image with an operator-built image
that additionally installs Playwright, Chromium, Xvfb and their Debian runtime dependencies. It is not included in the
base Moya image or the public-metadata collector image. The source Dockerfile copies this notice and the project
license, but publishing an official prebuilt auth image still requires an exact Python, Debian package and Chromium
license/source inventory for the built artifact; the Desktop sidecar inventory is not evidence for that container.

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
- Complete the container base-image, optional metadata-collector runtime and optional local-TTS Python dependency
  inventories before publishing official prebuilt images.
- Verify `LICENSE`, this notice, and bundled third-party license files in every official binary release artifact.

`pnpm licenses:generate` refreshes the path-free, deterministic pnpm production inventory.
`pnpm check:licenses:source-release` verifies the source-release license boundary. `pnpm check:licenses:release`
intentionally remains blocked until the binary redistribution items in `third_party/license-release-policy.json` are
resolved. Passing either automated inventory check is not legal approval.

This inventory records engineering provenance and is not legal advice.
