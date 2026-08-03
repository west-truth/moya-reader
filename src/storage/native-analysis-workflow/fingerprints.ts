import {
  analysisOutputIntegrityHash,
  characterGraphIntegrityHash,
  correctionCollectionIntegrityHash,
} from '../../domain/identity/ai-identities';
import type { Character, UserCorrection } from '../../domain/types';
import type { CharacterGraph, CharacterRelation } from '../../providers/ai';
import { requestToPromise, transactionDone } from '../indexeddb-transaction';
import { openReaderDb } from '../reader-database';
import type { NativeAnalysisArtifactPayload, NativeAnalysisPromotionSnapshot } from './types';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalCharacterGraph(
  novelId: string,
  characters: readonly Character[],
  relations: readonly CharacterRelation[],
): CharacterGraph {
  return {
    novelId,
    characters: [...characters].sort((left, right) => compareText(left.id, right.id)),
    relations: [...relations].sort((left, right) => compareText(left.id, right.id)),
  };
}

export function pinnedCorrections(corrections: readonly UserCorrection[], chapterId?: string): UserCorrection[] {
  return corrections
    .filter(
      (correction) =>
        correction.chapterId === chapterId ||
        correction.applyScope === 'future_pattern' ||
        correction.applyScope === 'global',
    )
    .sort((left, right) => compareText(right.createdAt, left.createdAt) || compareText(left.id, right.id))
    .slice(0, 30);
}

export function nativeAnalysisGraphFingerprint(
  novelId: string,
  characters: readonly Character[],
  relations: readonly CharacterRelation[],
): string {
  return characterGraphIntegrityHash(canonicalCharacterGraph(novelId, characters, relations));
}

export function nativeAnalysisCorrectionFingerprint(
  corrections: readonly UserCorrection[],
  chapterId?: string,
): string {
  return correctionCollectionIntegrityHash(pinnedCorrections(corrections, chapterId));
}

export function nativeAnalysisOutputHash(payload: NativeAnalysisArtifactPayload): string {
  return analysisOutputIntegrityHash(payload);
}

export async function getNativeAnalysisPromotionSnapshot(
  novelId: string,
  chapterId?: string,
): Promise<NativeAnalysisPromotionSnapshot> {
  const db = await openReaderDb();
  const tx = db.transaction(['novels', 'characters', 'character_relations', 'corrections'], 'readonly');
  const [novel, characters, relations, corrections] = await Promise.all([
    requestToPromise<{ activeContentRevisionId?: string } | undefined>(tx.objectStore('novels').get(novelId)),
    requestToPromise<Character[]>(tx.objectStore('characters').index('novelId').getAll(novelId)),
    requestToPromise<CharacterRelation[]>(tx.objectStore('character_relations').index('novelId').getAll(novelId)),
    requestToPromise<UserCorrection[]>(tx.objectStore('corrections').index('novelId').getAll(novelId)),
  ]);
  await transactionDone(tx);
  if (!novel?.activeContentRevisionId) throw new Error(`Active content revision not found for ${novelId}`);
  return {
    novelId,
    chapterId,
    activeContentRevisionId: novel.activeContentRevisionId,
    graphFingerprint: nativeAnalysisGraphFingerprint(novelId, characters, relations),
    correctionFingerprint: nativeAnalysisCorrectionFingerprint(corrections, chapterId),
  };
}
