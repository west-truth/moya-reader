/** Validate uploads before decoding or invoking a compatibility worker. No filesystem paths accepted. */
export function compatibilityFile(input: Record<string, unknown>): {
  bytes: Buffer;
  name: string;
  sourceIndex: number;
} {
  if (
    typeof input.name !== 'string' ||
    !/^.*\.(?:js|apk)$/i.test(input.name) ||
    input.name.length > 256 ||
    /[\\/]/.test(input.name) ||
    Array.from(input.name).some((char) => char.charCodeAt(0) < 32) ||
    typeof input.base64 !== 'string' ||
    input.base64.length > 44_739_244 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
  )
    throw new Error('compatibility_file_invalid');
  const bytes = Buffer.from(input.base64, 'base64');
  const maximum = /\.js$/i.test(input.name) ? 1024 * 1024 : 32 * 1024 * 1024;
  const sourceIndex = input.sourceIndex ?? 0;
  if (
    bytes.toString('base64') !== input.base64 ||
    !bytes.length ||
    bytes.length > maximum ||
    !Number.isSafeInteger(sourceIndex) ||
    (sourceIndex as number) < 0 ||
    (sourceIndex as number) >= 256
  )
    throw new Error('compatibility_file_invalid');
  return { bytes, name: input.name, sourceIndex: sourceIndex as number };
}
