import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

const MAX_DEX = 32 * 1024 * 1024;
const fail = () => {
  throw new Error('invalid_dex');
};

/** Static DEX type references only. Never loads classes or executes APK code. */
export function inspectDex(bytes) {
  if (
    bytes.length < 112 ||
    bytes.length > MAX_DEX ||
    !/^dex\n0(?:35|37|38|39|40)\0$/.test(Buffer.from(bytes.subarray(0, 8)).toString('ascii'))
  )
    fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset) => {
    if (offset < 0 || offset + 4 > bytes.length) fail();
    return view.getUint32(offset, true);
  };
  if (u32(32) !== bytes.length || u32(36) !== 112 || u32(40) !== 0x12345678) fail();
  const table = (header, width) => {
    const size = u32(header),
      offset = u32(header + 4);
    if (size > 1000000 || offset + size * width > bytes.length || (size && offset < 112)) fail();
    return { size, offset };
  };
  const stringTable = table(56, 4),
    typeTable = table(64, 4),
    classTable = table(96, 32);
  const string = (index) => {
    if (index >= stringTable.size) fail();
    let offset = u32(stringTable.offset + index * 4),
      count = 0;
    if (offset < 112 || offset >= bytes.length) fail();
    do {
      if (offset >= bytes.length || ++count > 5) fail();
    } while (bytes[offset++] & 128);
    const start = offset;
    while (offset < bytes.length && bytes[offset] !== 0 && offset - start <= 65536) offset++;
    if (offset === bytes.length || offset - start > 65536) fail();
    return Buffer.from(bytes.subarray(start, offset)).toString('utf8');
  };
  const types = Array.from({ length: typeTable.size }, (_, i) => string(u32(typeTable.offset + i * 4)));
  const defined = new Set();
  for (let i = 0; i < classTable.size; i++) {
    const index = u32(classTable.offset + i * 32);
    if (index >= types.length) fail();
    defined.add(types[index]);
  }
  return { types, defined: [...defined] };
}

export async function inspectApk(bytes) {
  if (bytes.length > MAX_DEX) throw new Error('apk_size_limit');
  const archive = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await archive.getEntries();
    const dex = entries.filter((entry) => /^classes(?:[2-9]|[1-9]\d+)?\.dex$/.test(entry.filename));
    if (!dex.length || dex.length > 16 || !entries.some((entry) => entry.filename === 'AndroidManifest.xml'))
      throw new Error('invalid_apk');
    if (
      dex.some((entry) => entry.uncompressedSize > MAX_DEX) ||
      dex.reduce((n, entry) => n + entry.uncompressedSize, 0) > 128 * 1024 * 1024
    )
      throw new Error('dex_size_limit');
    const types = new Set(),
      defined = new Set();
    for (const entry of dex) {
      const result = inspectDex(await entry.getData(new Uint8ArrayWriter()));
      for (const type of result.types) types.add(type.replace(/^\[+/, ''));
      for (const type of result.defined) defined.add(type);
    }
    const external = [...types].filter((type) => type.startsWith('L') && !defined.has(type)).sort();
    const uses = (prefix) => external.some((type) => type.startsWith(prefix));
    const families = {};
    for (const type of external) {
      const family = type.slice(1).split('/').slice(0, 2).join('/');
      families[family] = (families[family] ?? 0) + 1;
    }
    return {
      schemaVersion: 1,
      apkSha256: createHash('sha256').update(bytes).digest('hex'),
      apkBytes: bytes.length,
      dexFiles: dex.length,
      definedClasses: defined.size,
      externalTypes: external.length,
      dependencies: families,
      features: {
        sourceApi: uses('Leu/kanade/tachiyomi/source/'),
        webView: uses('Landroid/webkit/'),
        androidContext: uses('Landroid/content/'),
        preferences: uses('Landroidx/preference/'),
        javascriptEngine: uses('Lcom/squareup/duktape/') || uses('Lapp/cash/quickjs/'),
        nativeLibraries: entries.some((entry) => /^lib\/[^/]+\/[^/]+\.so$/.test(entry.filename)),
      },
      external,
    };
  } finally {
    await archive.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) throw new Error('usage: node scripts/apk-compat/inspect.mjs <local.apk> [--details]');
  const report = await inspectApk(await readFile(path));
  if (!process.argv.includes('--details')) delete report.external;
  console.log(JSON.stringify(report, null, 2));
}
