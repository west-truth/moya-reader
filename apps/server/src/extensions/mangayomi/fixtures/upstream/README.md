# Original Mangayomi sources for compatibility tests

The `.js.txt` files are byte-for-byte snapshots, not executable build inputs. Tests load them as original guest
source in the existing QuickJS runtime. HTTP responses are synthetic local fixtures; no website is contacted.

Repository: https://github.com/kodjodevf/mangayomi-extensions

Revision: `6004f1f8d1a56f882dadb734ce26f50c626a3850`

| Snapshot            | Original path                           | SHA-256                                                            |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `asurascans.js.txt` | `javascript/manga/src/en/asurascans.js` | `25fe2a577a10e3babb5a628e04f6e8da01e6da217456643916c240162f5de2c4` |
| `wordrain69.js.txt` | `javascript/novel/src/en/wordrain69.js` | `c19e1ab9e629bc0af454b23bbbe81365e1e85b1ff43d97231dc8ecdeaf503920` |

Additional original: `mangadex.js.txt` from `javascript/manga/src/all/mangadex.js` at the same revision.
SHA-256: `46369adf82b4eb14abcb6f6248a6deaaaea125c11a77a335791ef2e7a1ff49b3`.
Its conformance case exercises multi-language file import, original preference defaults, selection persistence,
work/release mapping and an image asset through the host. HTTP responses remain deterministic fixtures.

Copyright and authorship remain with the upstream contributors. The original Apache-2.0 license is retained in
`LICENSE`; none of the snapshots is modified. Refresh these snapshots deliberately together with their digests and
contract expectations. Passing fixtures proves the exercised adapter paths, not live site availability.
