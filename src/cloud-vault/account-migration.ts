import type { CloudVaultContentProvider, CloudVaultSnapshotV1 } from './contracts';
import { decryptCloudVaultAiTts } from './crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../domain/canonical-json';

/** Hydrate every legacy sidecar before removing its password dependency, regardless of selected sync scope. */
export async function migrateLegacyCloudVault(
  snapshot: CloudVaultSnapshotV1,
  provider: CloudVaultContentProvider | undefined,
  passphrase: string,
): Promise<CloudVaultSnapshotV1> {
  const books = [];
  for (const book of snapshot.books) {
    if (!book.aiTtsObject) {
      books.push(book);
      continue;
    }
    if (!provider) throw new Error('기존 동기화 파일을 열 수 있는 저장소 연결이 필요합니다.');
    const stored = await provider.getObject(book.aiTtsObject.objectKey);
    if (!stored || stored.blob.size !== book.aiTtsObject.byteLength)
      throw new Error('기존 AI/TTS 파일을 복구하지 못해 동기화 전환을 중단했습니다.');
    const value = await decryptCloudVaultAiTts(new Uint8Array(await stored.blob.arrayBuffer()), passphrase);
    const hash = 'sha256:' + bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))));
    if (value.bookHash !== book.identity.normalizedTextHash || hash !== book.aiTtsObject.artifactHash)
      throw new Error('기존 AI/TTS 파일의 내용이 일치하지 않습니다.');
    books.push({
      ...book,
      chapters: value.chapters,
      paragraphs: value.paragraphs,
      characters: value.characters,
      characterRelations: value.characterRelations,
      segments: value.segments,
      voiceProfiles: value.voiceProfiles,
      corrections: value.corrections,
      aiTtsObject: undefined,
    });
  }
  return { ...snapshot, books };
}
