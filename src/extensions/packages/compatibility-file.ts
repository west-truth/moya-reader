/** Keep raw code out of JSON until its bounded size is checked. */
export async function compatibilityFileUpload(file: File, sourceIndex = 0) {
  const maximum = /\.js$/i.test(file.name) ? 1024 * 1024 : /\.apk$/i.test(file.name) ? 32 * 1024 * 1024 : 0;
  if (!file.size || file.size > maximum) throw new Error('compatibility_file_invalid');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 16384)
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 16384)));
  return { name: file.name, base64: btoa(chunks.join('')), sourceIndex };
}
