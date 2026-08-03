import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { SourceMentionV1 } from './mention-inventory';

export const SPEAKER_ENTITY_VERSION = 'speaker-entity-v2' as const;

export function canonicalSpeakerEntityId(bookId: string, characterId: string): string {
  return persistentId128('canonical_speaker_entity', [bookId, characterId]);
}

export interface SpeakerEntitySourceAnchorV1 {
  readonly mentionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly paragraphId: string;
  readonly paragraphIndex: number;
  readonly spanId: string;
  readonly spanIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface SpeakerEntityV1 {
  readonly version: typeof SPEAKER_ENTITY_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly entityKind: 'canonical_character' | 'provisional' | 'ephemeral' | 'group';
  readonly status: 'active' | 'ambiguous' | 'rejected';
  readonly characterId?: string;
  readonly displayName: string;
  readonly normalizedSurfaces: readonly string[];
  readonly effectiveFromScene: number;
  readonly effectiveToScene?: number;
  readonly sceneId?: string;
  readonly provenance: readonly string[];
  readonly trustLevel: 'low' | 'medium' | 'high';
  readonly evidenceMentionIds: readonly string[];
  readonly evidenceSpanIds: readonly string[];
  readonly firstEvidence?: SpeakerEntitySourceAnchorV1;
  readonly promotionEligible: boolean;
  readonly fingerprint: string;
}

export function canPromoteSpeakerEntity(entity: SpeakerEntityV1, userConfirmed = false): boolean {
  return userConfirmed || (entity.entityKind === 'provisional' && entity.evidenceSpanIds.length >= 2);
}

export function coalesceSourceSpeakerEntitiesForMemory(
  entities: readonly SpeakerEntityV1[],
): readonly SpeakerEntityV1[] {
  const result: SpeakerEntityV1[] = [];
  const provisional = new Map<string, SpeakerEntityV1[]>();
  for (const entity of entities) {
    if (entity.entityKind !== 'provisional') {
      result.push(entity);
      continue;
    }
    const surface = entity.normalizedSurfaces[0] ?? entity.displayName;
    const key = `${entity.bookId}:${entity.contentRevisionId}:${entity.chapterId}:${entity.sceneId ?? entity.id}:${surface}`;
    provisional.set(key, [...(provisional.get(key) ?? []), entity]);
  }

  for (const rows of provisional.values()) {
    if (rows.length === 1) {
      result.push(rows[0]!);
      continue;
    }
    const first = [...rows].sort(
      (left, right) =>
        left.effectiveFromScene - right.effectiveFromScene || left.chapterId.localeCompare(right.chapterId),
    )[0]!;
    const surface = first.normalizedSurfaces[0] ?? first.displayName;
    const evidenceMentionIds = [...new Set(rows.flatMap((row) => row.evidenceMentionIds))].sort();
    const evidenceSpanIds = [...new Set(rows.flatMap((row) => row.evidenceSpanIds))].sort();
    const promotionEligible = evidenceSpanIds.length >= 2;
    const core = {
      version: SPEAKER_ENTITY_VERSION,
      bookId: first.bookId,
      contentRevisionId: first.contentRevisionId,
      chapterId: first.chapterId,
      entityKind: 'provisional' as const,
      status: promotionEligible ? ('active' as const) : ('ambiguous' as const),
      displayName: first.displayName,
      normalizedSurfaces: [...new Set(rows.flatMap((row) => row.normalizedSurfaces))].sort(),
      effectiveFromScene: Math.min(...rows.map((row) => row.effectiveFromScene)),
      effectiveToScene: undefined,
      sceneId: undefined,
      provenance: [...new Set(rows.flatMap((row) => row.provenance))].sort(),
      trustLevel: promotionEligible ? ('medium' as const) : ('low' as const),
      evidenceMentionIds,
      evidenceSpanIds,
      firstEvidence: [...rows]
        .map((row) => row.firstEvidence)
        .filter((anchor): anchor is SpeakerEntitySourceAnchorV1 => Boolean(anchor))
        .sort(
          (left, right) =>
            left.paragraphIndex - right.paragraphIndex ||
            left.spanIndex - right.spanIndex ||
            left.startOffset - right.startOffset,
        )[0],
      promotionEligible,
    };
    const fingerprint = structuredIntegrityHash(core);
    result.push({
      ...core,
      id: persistentId128('speaker_entity_memory', [first.contentRevisionId, surface, fingerprint]),
      fingerprint,
    });
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

export function deriveSourceSpeakerEntities(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly mentions: readonly SourceMentionV1[];
  readonly sceneOrdinalById: Readonly<Record<string, number>>;
}): readonly SpeakerEntityV1[] {
  const groups = new Map<string, SourceMentionV1[]>();
  for (const mention of input.mentions) {
    if (mention.characterId || ['address_term', 'pronoun'].includes(mention.type)) continue;
    const kind = ['name', 'name_variant', 'title_name', 'address_name'].includes(mention.type)
      ? 'provisional'
      : mention.type === 'group_entity'
        ? 'group'
        : mention.type === 'generic_role' || mention.type === 'role_description'
          ? 'ephemeral'
          : undefined;
    if (!kind) continue;
    const scope = mention.sceneId;
    const key = `${kind}:${scope}:${mention.normalizedSurface}`;
    groups.set(key, [...(groups.get(key) ?? []), mention]);
  }
  return [...groups.entries()].map(([key, mentions]) => {
    const orderedMentions = [...mentions].sort(
      (left, right) =>
        left.paragraphIndex - right.paragraphIndex ||
        left.spanIndex - right.spanIndex ||
        left.startOffset - right.startOffset ||
        left.id.localeCompare(right.id),
    );
    const first = orderedMentions[0]!;
    const entityKind = key.split(':', 1)[0] as SpeakerEntityV1['entityKind'];
    const independentEvidenceCount = new Set(mentions.map((mention) => mention.spanId)).size;
    const sceneOrdinals = mentions.map((mention) => input.sceneOrdinalById[mention.sceneId] ?? 0);
    const core = {
      version: SPEAKER_ENTITY_VERSION,
      bookId: input.bookId,
      contentRevisionId: input.contentRevisionId,
      chapterId: first.chapterId,
      entityKind,
      status:
        independentEvidenceCount >= 2 || entityKind !== 'provisional' ? ('active' as const) : ('ambiguous' as const),
      displayName: first.normalizedSurface,
      normalizedSurfaces: [...new Set(mentions.map((mention) => mention.normalizedSurface))].sort(),
      effectiveFromScene: Math.min(...sceneOrdinals),
      effectiveToScene: Math.max(...sceneOrdinals),
      sceneId: first.sceneId,
      provenance: [...new Set(mentions.map((mention) => mention.extractionCode))].sort(),
      trustLevel: independentEvidenceCount >= 2 ? ('medium' as const) : ('low' as const),
      evidenceMentionIds: mentions.map((mention) => mention.id).sort(),
      evidenceSpanIds: [...new Set(mentions.map((mention) => mention.spanId))].sort(),
      firstEvidence: {
        mentionId: first.id,
        chapterId: first.chapterId,
        sceneId: first.sceneId,
        paragraphId: first.paragraphId,
        paragraphIndex: first.paragraphIndex,
        spanId: first.spanId,
        spanIndex: first.spanIndex,
        startOffset: first.startOffset,
        endOffset: first.endOffset,
      },
      promotionEligible: entityKind === 'provisional' && independentEvidenceCount >= 2,
    };
    const fingerprint = structuredIntegrityHash(core);
    return {
      ...core,
      id: persistentId128('speaker_entity', [input.contentRevisionId, entityKind, key, fingerprint]),
      fingerprint,
    };
  });
}
