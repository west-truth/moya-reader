# Windows source materials

`windows-source-manifest.json` pins the downloaded source archives by SHA-256.
`windows-cargo-inventory.json` records the Windows Cargo dependency graph, including build dependencies,
with the lockfile digest and verbatim license files. These inventories cover the stated components;
they do not certify every file in an installer.

Generate the companion source archive from the release commit with Python 3.11 or later:

```sh
python scripts/desktop/prepare-source-bundle.py
```

Publish the generated archive and checksum beside the matching installer. It includes the Moya source
at the recorded commit, the manifests, notices and original upstream archives. It contains no user data.
The source cache can be reused with `--cache PATH`. Downloads are rejected on checksum mismatch.

## Rebuilding or replacing libraries

- **7z-wasm 1.2.0:** wrapper commit `521d2cf93f5964f4e77b01049e19f1b29305c454`,
  upstream 7-Zip 24.09. The wrapper archive includes its Docker build recipe and patch.
  Keep the LGPL and unRAR notices with rebuilt output. The upstream recipe uses an unpinned Emscripten
  image, so reproducing the npm binary byte for byte has not been demonstrated.
- **libarchive-wasm 1.2.0:** wrapper commit `2e72c66d92fb8aa5914d0ff2f9e29608e38f2294`.
  Its `lib/Dockerfile` specifies Emscripten 4.0.5 and the included compression/crypto source versions.
  Follow that recipe and the wrapper build scripts to replace the separately loaded WASM file.
- **Redis 7.2.16 on Windows:** upstream Redis sources and redis-windows build recipes are included.
  Cygwin source packages include their `.cygport` recipes and patches. The DLL versions were matched
  against official Cygwin packages; rebased DLLs were compared after normalizing PE image-base
  relocations and checksum. The manifest records the distributed and upstream DLL hashes.
- **sharp/libvips:** sources, patches and the sharp-libvips 1.2.4 / Windows libvips 8.17.3 build recipes
  are included. The dynamically loaded DLLs are in `embedded-server/server/node_modules/@img/sharp-win32-x64/lib`.
  Follow the upstream Windows recipes to build compatible replacements. This capture is not yet a
  verified clean rebuild of every statically linked dependency inside those DLLs.
- **Rust:** registry source URLs are in the Cargo inventory. MPL source crates are included in the
  companion archive. Build instructions for Moya are in `docs/platforms/native-build-guide-ko.md`.

Moya does not restrict modification of these libraries or reverse engineering to debug those modifications.
A modified library must preserve the interface expected by its caller; replacements are not integrity-locked
by the application. Keep a backup of the original installation when testing rebuilt libraries.

## Scope still requiring final artifact review

The packaged runtime also contains Node, PostgreSQL, Cloudflare Tunnel, Python/PyInstaller,
Chromium, FFmpeg and npm native dependencies. Their own packaged notices remain required.
The Python inventory is generated during the Windows build, and Chromium's `LICENSE.headless_shell`
is shipped in its browser directory. Browser codec source coverage and native npm dependency
coverage still need to be checked against the final installer before public binary release.
The generic binary release gate remains closed; this source capture does not remove its blockers.
