import { sha256 as sha256Digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../domain/canonical-json';
import {
  CLOUD_VAULT_AI_TTS_FORMAT,
  CLOUD_VAULT_AI_TTS_VERSION,
  type CloudVaultAiTtsObjectV1,
  type CloudVaultAiTtsPayloadV1,
  type CloudVaultBookV1,
  type CloudVaultContentProvider,
  type CloudVaultSnapshotV1,
} from './contracts';
import { decryptCloudVaultAiTts, encryptCloudVaultAiTts } from './crypto';

const encoder = new TextEncoder();

function taggedHash(value: Uint8Array): string {
  return `sha256:${bytesToHex(sha256Digest(value))}`;
}

function objectKey(artifactHash: string): string {
  const hex = artifactHash.replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('Cloud Vault AI/TTS artifact hash is invalid.');
  return `ai-tts/v1/sha256/${hex}`;
}

function sortedById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function payload(book: CloudVaultBookV1): CloudVaultAiTtsPayloadV1 {
  return {
    format: CLOUD_VAULT_AI_TTS_FORMAT,
    version: CLOUD_VAULT_AI_TTS_VERSION,
    bookHash: book.identity.normalizedTextHash,
    revisionAt: book.revisions.aiTtsAt,
    chapters: sortedById(book.chapters),
    paragraphs: sortedById(book.paragraphs),
    characters: sortedById(book.characters),
    characterRelations: sortedById(book.characterRelations),
    segments: sortedById(book.segments),
    voiceProfiles: sortedById(book.voiceProfiles),
    corrections: sortedById(book.corrections),
  };
}

function artifactHash(value: CloudVaultAiTtsPayloadV1): string {
  return taggedHash(encoder.encode(canonicalJson(value)));
}

function hasArtifacts(book: CloudVaultBookV1): boolean {
  return (
    book.characters.length > 0 ||
    book.characterRelations.length > 0 ||
    book.segments.length > 0 ||
    book.voiceProfiles.length > 0 ||
    book.corrections.length > 0
  );
}

function withoutInlineArtifacts(book: CloudVaultBookV1, aiTtsObject = book.aiTtsObject): CloudVaultBookV1 {
  return {
    ...book,
    characters: [],
    characterRelations: [],
    segments: [],
    voiceProfiles: [],
    corrections: [],
    aiTtsObject,
  };
}

export interface CloudVaultAiTtsTransferReport {
  readonly uploadedAiTtsFiles: number;
  readonly restoredAiTtsFiles: number;
  readonly uploadedAiTtsBytes: number;
  readonly downloadedAiTtsBytes: number;
  readonly aiTtsObjectKeys: Readonly<Record<string, string>>;
  readonly contentFailures: readonly string[];
}

export const EMPTY_AI_TTS_TRANSFER_REPORT: CloudVaultAiTtsTransferReport = {
  uploadedAiTtsFiles: 0,
  restoredAiTtsFiles: 0,
  uploadedAiTtsBytes: 0,
  downloadedAiTtsBytes: 0,
  aiTtsObjectKeys: {},
  contentFailures: [],
};

export class CloudVaultAiTtsTransferService {
  async hydrateRemote(
    remote: CloudVaultSnapshotV1 | undefined,
    local: CloudVaultSnapshotV1,
    provider: CloudVaultContentProvider,
    passphrase: string,
    knownObjectKeys: Readonly<Record<string, string>> = {},
  ): Promise<{ snapshot: CloudVaultSnapshotV1 | undefined; report: CloudVaultAiTtsTransferReport }> {
    if (!remote || !local.scope.aiTtsArtifacts) return { snapshot: remote, report: EMPTY_AI_TTS_TRANSFER_REPORT };
    const localByHash = new Map(local.books.map((book) => [book.identity.normalizedTextHash, book]));
    const keys = Object.fromEntries(Object.entries(knownObjectKeys).filter(([hash]) => localByHash.has(hash)));
    const failures: string[] = [];
    let restoredAiTtsFiles = 0;
    let downloadedAiTtsBytes = 0;
    const books: CloudVaultBookV1[] = [];

    for (const book of remote.books) {
      const descriptor = book.aiTtsObject;
      if (!descriptor) {
        books.push(book);
        continue;
      }
      const hash = book.identity.normalizedTextHash;
      const localBook = localByHash.get(hash);
      const alreadyApplied =
        knownObjectKeys[hash] === descriptor.objectKey &&
        localBook !== undefined &&
        hasArtifacts(localBook) &&
        localBook.revisions.aiTtsAt >= descriptor.revisionAt;
      if (alreadyApplied) {
        keys[hash] = descriptor.objectKey;
        books.push(book);
        continue;
      }
      try {
        const stored = await provider.getObject(descriptor.objectKey);
        if (!stored) throw new Error('클라우드에 AI/TTS 파일이 없습니다.');
        if (stored.blob.size !== descriptor.byteLength) throw new Error('AI/TTS 파일 크기가 일치하지 않습니다.');
        const value = await decryptCloudVaultAiTts(new Uint8Array(await stored.blob.arrayBuffer()), passphrase);
        if (value.bookHash !== hash || artifactHash(value) !== descriptor.artifactHash) {
          throw new Error('AI/TTS 파일 식별자가 일치하지 않습니다.');
        }
        if (localBook) keys[hash] = descriptor.objectKey;
        restoredAiTtsFiles += 1;
        downloadedAiTtsBytes += stored.blob.size;
        books.push({
          ...book,
          chapters: value.chapters,
          paragraphs: value.paragraphs,
          characters: value.characters,
          characterRelations: value.characterRelations,
          segments: value.segments,
          voiceProfiles: value.voiceProfiles,
          corrections: value.corrections,
        });
      } catch (error) {
        failures.push(`${book.identity.title}: ${error instanceof Error ? error.message : 'AI/TTS 복원 실패'}`);
        books.push(book);
      }
    }

    return {
      snapshot: { ...remote, books },
      report: {
        ...EMPTY_AI_TTS_TRANSFER_REPORT,
        restoredAiTtsFiles,
        downloadedAiTtsBytes,
        aiTtsObjectKeys: keys,
        contentFailures: failures,
      },
    };
  }

  async externalize(
    snapshot: CloudVaultSnapshotV1,
    provider: CloudVaultContentProvider,
    passphrase: string,
    knownObjectKeys: Readonly<Record<string, string>> = {},
    locallyAvailableBookHashes?: ReadonlySet<string>,
  ): Promise<{ snapshot: CloudVaultSnapshotV1; report: CloudVaultAiTtsTransferReport }> {
    if (!snapshot.scope.aiTtsArtifacts) return { snapshot, report: EMPTY_AI_TTS_TRANSFER_REPORT };
    const keys = Object.fromEntries(
      Object.entries(knownObjectKeys).filter(
        ([hash]) => !locallyAvailableBookHashes || locallyAvailableBookHashes.has(hash),
      ),
    );
    const failures: string[] = [];
    let uploadedAiTtsFiles = 0;
    let uploadedAiTtsBytes = 0;
    const books: CloudVaultBookV1[] = [];

    for (const book of snapshot.books) {
      const hash = book.identity.normalizedTextHash;
      if (!hasArtifacts(book)) {
        if (book.aiTtsObject && (!locallyAvailableBookHashes || locallyAvailableBookHashes.has(hash))) {
          keys[hash] = book.aiTtsObject.objectKey;
        }
        books.push(withoutInlineArtifacts(book));
        continue;
      }
      try {
        const value = payload(book);
        const hashValue = artifactHash(value);
        if (book.aiTtsObject?.artifactHash === hashValue) {
          if (!locallyAvailableBookHashes || locallyAvailableBookHashes.has(hash)) {
            keys[hash] = book.aiTtsObject.objectKey;
          }
          books.push(withoutInlineArtifacts(book));
          continue;
        }
        const bytes = await encryptCloudVaultAiTts(value, passphrase);
        const descriptor: CloudVaultAiTtsObjectV1 = {
          kind: 'ai-tts',
          objectKey: objectKey(hashValue),
          artifactHash: hashValue,
          byteLength: bytes.byteLength,
          revisionAt: value.revisionAt,
        };
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const stored = await provider.putObject(descriptor.objectKey, new Blob([buffer]), {
          byteLength: descriptor.byteLength,
        });
        if (stored.created) {
          uploadedAiTtsFiles += 1;
          uploadedAiTtsBytes += bytes.byteLength;
        }
        if (!locallyAvailableBookHashes || locallyAvailableBookHashes.has(hash)) keys[hash] = descriptor.objectKey;
        books.push(withoutInlineArtifacts(book, descriptor));
      } catch (error) {
        failures.push(`${book.identity.title}: ${error instanceof Error ? error.message : 'AI/TTS 업로드 실패'}`);
        // Preserve inline artifacts until a later sync can externalize them safely.
        books.push(book);
      }
    }

    return {
      snapshot: { ...snapshot, books },
      report: {
        ...EMPTY_AI_TTS_TRANSFER_REPORT,
        uploadedAiTtsFiles,
        uploadedAiTtsBytes,
        aiTtsObjectKeys: keys,
        contentFailures: failures,
      },
    };
  }
}
