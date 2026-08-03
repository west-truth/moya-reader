import pg from 'pg';
import type { AnalysisStatus, Character, LabeledSegment, SegmentType } from '@noveldesk/contracts';
import { matchesIntegrityHash } from '@noveldesk/text-core/hash';
import type { CharacterRelation } from '../../../../../src/providers/ai.js';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { hasSecretLikeKey as hasSecretLikeKeyOrValue } from '../../providers/server-provider-settings.js';
import {
  parseVoiceCastingUpdatedPayload as parseSharedVoiceCastingUpdatedPayload,
  type VoiceCastingUpdatedPayloadV1,
} from '../../../../../src/sync/voice-casting-event.js';

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

export function jsonFromString(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const voiceProfileRoles = new Set(['narrator', 'character', 'system', 'unknown']);
const correctionTypes = new Set(['speaker', 'listener', 'emotion', 'prosody', 'segment_type', 'voice', 'note']);
const correctionScopes = new Set(['segment', 'chapter', 'future_pattern', 'global']);
const characterGraphModes = new Set(['patch', 'replace']);
const chapterSegmentModes = new Set(['patch', 'replace']);
const documentAnnotationTypes = new Set([
  'page_bookmark',
  'text_highlight',
  'text_note',
  'region_highlight',
  'region_note',
]);
const fixedDocumentAnchorKinds = new Set(['fixed_page', 'fixed_text', 'fixed_region']);

function validNormalizedQuads(value: unknown, required: boolean): boolean {
  if (value === undefined) return !required;
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > 512) return false;
  return value.every((item) => {
    const quad = record(item);
    const x = Number(quad.x);
    const y = Number(quad.y);
    const width = Number(quad.width);
    const height = Number(quad.height);
    return (
      [x, y, width, height].every(Number.isFinite) &&
      x >= 0 &&
      y >= 0 &&
      width >= 0 &&
      height >= 0 &&
      x + width <= 1.001 &&
      y + height <= 1.001
    );
  });
}
const analysisStatuses = new Set<AnalysisStatus>([
  'not_analyzed',
  'mock_ready',
  'queued',
  'building_graph',
  'analyzing_characters',
  'labeling_segments',
  'validating',
  'ready',
  'needs_review',
  'failed',
  'cancelled',
]);
const segmentTypes = new Set<SegmentType>([
  'narration',
  'quoted_dialogue',
  'plain_dialogue',
  'inner_monologue',
  'system_message',
  'sfx',
  'author_note',
  'unknown',
]);

export function analysisStatusValue(value: unknown): AnalysisStatus | undefined {
  return typeof value === 'string' && analysisStatuses.has(value as AnalysisStatus)
    ? (value as AnalysisStatus)
    : undefined;
}

export function parseVoiceProfilesPayload(
  event: SyncEvent,
):
  | { ok: true; bookId: string; profiles: Record<string, unknown>[]; updatedAt: string }
  | { ok: false; message: string } {
  const payload = record(event.payload);
  const bookId = event.novelId ?? stringValue(payload.bookId) ?? stringValue(payload.novelId);
  if (!bookId) return { ok: false, message: 'voice profile event is missing a book id' };
  if (!Array.isArray(payload.voiceProfiles)) {
    return { ok: false, message: 'voice_profiles_updated requires a voiceProfiles array' };
  }

  const profiles = payload.voiceProfiles.map(record);
  for (const profile of profiles) {
    const role = stringValue(profile.role);
    const id = stringValue(profile.id);
    const providerId = stringValue(profile.providerId);
    const providerVoiceId = stringValue(profile.providerVoiceId);
    const label = stringValue(profile.label);
    const speed = numberValue(profile.speed, 1);
    const pitch =
      profile.pitch === undefined || profile.pitch === null ? undefined : numberValue(profile.pitch, Number.NaN);
    const providerOptions = record(profile.providerOptions);
    if (!id || !role || !voiceProfileRoles.has(role) || !providerId || !providerVoiceId || !label) {
      return { ok: false, message: 'voice_profiles_updated contains an invalid voice profile' };
    }
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4 || (pitch !== undefined && !Number.isFinite(pitch))) {
      return { ok: false, message: 'voice_profiles_updated contains invalid voice parameters' };
    }
    if (hasSecretLikeKeyOrValue(providerOptions)) {
      return {
        ok: false,
        message: 'voice profile providerOptions must not contain secret-like keys or values',
      };
    }
  }

  return {
    ok: true,
    bookId,
    profiles,
    updatedAt: String(event.revision?.updatedAt ?? event.createdAt),
  };
}

export function parseDocumentAnnotationPayload(
  event: SyncEvent,
):
  | { ok: true; bookId: string; id: string; pageIndex: number; annotation: Record<string, unknown>; updatedAt: string }
  | { ok: false; message: string } {
  const payload = record(event.payload);
  const annotation = record(payload.annotation);
  const bookId = event.novelId ?? stringValue(annotation.bookId);
  const id = stringValue(annotation.id) ?? event.entityId;
  const pageIndex = Number(annotation.pageIndex);
  const annotationType = stringValue(annotation.type);
  const anchor = record(annotation.anchor);
  const anchorKind = stringValue(anchor.kind);
  const anchorPageIndex = Number(anchor.pageIndex);
  if (!bookId || !id) return { ok: false, message: 'document annotation is missing an id or book id' };
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || anchorPageIndex !== pageIndex) {
    return { ok: false, message: 'document annotation requires a matching non-negative page index' };
  }
  if (!annotationType || !documentAnnotationTypes.has(annotationType)) {
    return { ok: false, message: 'document annotation has an unsupported type' };
  }
  if (!anchorKind || !fixedDocumentAnchorKinds.has(anchorKind)) {
    return { ok: false, message: 'document annotation requires a fixed-document anchor' };
  }
  if (stringValue(anchor.bookId) && stringValue(anchor.bookId) !== bookId) {
    return { ok: false, message: 'document annotation anchor belongs to another book' };
  }
  if (anchorKind === 'fixed_page' && !stringValue(anchor.pageHash)) {
    return { ok: false, message: 'fixed page annotation requires a page hash' };
  }
  if (
    anchorKind === 'fixed_text' &&
    (!stringValue(anchor.textRevisionId) ||
      !stringValue(anchor.blockId) ||
      !Number.isInteger(Number(anchor.startOffset)) ||
      !Number.isInteger(Number(anchor.endOffset)) ||
      Number(anchor.startOffset) > Number(anchor.endOffset))
  ) {
    return { ok: false, message: 'fixed text annotation has an invalid text range' };
  }
  if (anchorKind === 'fixed_text' && !validNormalizedQuads(anchor.quads, false)) {
    return { ok: false, message: 'fixed text annotation has invalid quads' };
  }
  if (anchorKind === 'fixed_region' && (!stringValue(anchor.pageHash) || !validNormalizedQuads(anchor.quads, true))) {
    return { ok: false, message: 'fixed region annotation requires a page hash and quads' };
  }
  return {
    ok: true,
    bookId,
    id,
    pageIndex,
    annotation,
    updatedAt: String(annotation.updatedAt ?? event.revision?.updatedAt ?? event.createdAt),
  };
}

export function parseDocumentAnnotationDeletedPayload(
  event: SyncEvent,
): { ok: true; bookId: string; id: string; deletedAt: string } | { ok: false; message: string } {
  const payload = record(event.payload);
  const annotation = record(payload.annotation);
  const bookId = event.novelId ?? stringValue(annotation.bookId);
  const id = stringValue(payload.id) ?? event.entityId;
  if (!bookId || !id) return { ok: false, message: 'document annotation deletion is missing an id or book id' };
  return { ok: true, bookId, id, deletedAt: String(payload.deletedAt ?? event.createdAt) };
}

const MAX_DOCUMENT_ORDER_FINGERPRINTS = 10_000;

function validDocumentOrderFingerprints(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_DOCUMENT_ORDER_FINGERPRINTS &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
  );
}

export function parseDocumentTextOrderOverridePayload(event: SyncEvent):
  | {
      ok: true;
      bookId: string;
      id: string;
      pageIndex: number;
      pageHash: string;
      sourceRevisionId: string;
      orderedBlockFingerprints: string[];
      excludedBlockFingerprints: string[];
      createdAt: string;
      updatedAt: string;
    }
  | { ok: false; message: string } {
  const payload = record(event.payload);
  const orderOverride = record(payload.orderOverride);
  const bookId = event.novelId ?? stringValue(orderOverride.bookId);
  const id = stringValue(orderOverride.id) ?? event.entityId;
  const pageIndex = Number(orderOverride.pageIndex);
  const pageHash = stringValue(orderOverride.pageHash);
  const sourceRevisionId = stringValue(orderOverride.sourceRevisionId);
  if (!bookId || !id) return { ok: false, message: 'document text order override is missing an id or book id' };
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return { ok: false, message: 'document text order override requires a non-negative page index' };
  }
  if (!pageHash || !sourceRevisionId) {
    return { ok: false, message: 'document text order override requires page and source revision hashes' };
  }
  if (
    !validDocumentOrderFingerprints(orderOverride.orderedBlockFingerprints) ||
    !validDocumentOrderFingerprints(orderOverride.excludedBlockFingerprints)
  ) {
    return { ok: false, message: 'document text order override contains invalid block fingerprints' };
  }
  return {
    ok: true,
    bookId,
    id,
    pageIndex,
    pageHash,
    sourceRevisionId,
    orderedBlockFingerprints: orderOverride.orderedBlockFingerprints,
    excludedBlockFingerprints: orderOverride.excludedBlockFingerprints,
    createdAt: String(orderOverride.createdAt ?? event.createdAt),
    updatedAt: String(orderOverride.updatedAt ?? event.revision?.updatedAt ?? event.createdAt),
  };
}

export function parseDocumentTextOrderOverrideDeletedPayload(
  event: SyncEvent,
): { ok: true; bookId: string; id: string; pageIndex: number; deletedAt: string } | { ok: false; message: string } {
  const payload = record(event.payload);
  const orderOverride = record(payload.orderOverride);
  const bookId = event.novelId ?? stringValue(orderOverride.bookId);
  const id = stringValue(payload.id) ?? stringValue(orderOverride.id) ?? event.entityId;
  const pageIndex = Number(payload.pageIndex ?? orderOverride.pageIndex);
  if (!bookId || !id)
    return { ok: false, message: 'document text order override deletion is missing an id or book id' };
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return { ok: false, message: 'document text order override deletion requires a non-negative page index' };
  }
  return { ok: true, bookId, id, pageIndex, deletedAt: String(payload.deletedAt ?? event.createdAt) };
}

export function parseVoiceCastingUpdatedPayload(
  event: SyncEvent,
):
  | { ok: true; bookId: string; payload: VoiceCastingUpdatedPayloadV1; updatedAt: string }
  | { ok: false; message: string } {
  const payload = record(event.payload);
  const bookId = event.novelId ?? stringValue(payload.bookId) ?? stringValue(payload.novelId);
  if (!bookId) return { ok: false, message: 'voice_casting_updated is missing a book id' };
  if (hasSecretLikeKeyOrValue(event.payload)) {
    return { ok: false, message: 'voice_casting_updated must not contain secret-like keys or values' };
  }
  const parsed = parseSharedVoiceCastingUpdatedPayload(event.payload, bookId);
  if (!parsed) {
    return {
      ok: false,
      message: 'voice_casting_updated must contain only a valid user-authored voice casting projection',
    };
  }
  return {
    ok: true,
    bookId,
    payload: parsed,
    updatedAt: String(event.revision?.updatedAt ?? event.createdAt),
  };
}

export function parseCorrectionPayload(
  event: SyncEvent,
): { ok: true; bookId: string; correction: Record<string, unknown> } | { ok: false; message: string } {
  const payload = record(event.payload);
  const correction = record(payload.correction);
  const bookId = event.novelId ?? stringValue(correction.novelId) ?? stringValue(correction.bookId);
  const id = stringValue(correction.id) ?? event.entityId;
  const chapterId = stringValue(correction.chapterId);
  const correctionType = stringValue(correction.correctionType);
  const afterJson = stringValue(correction.afterJson);
  const applyScope = stringValue(correction.applyScope);
  const createdAt = stringValue(correction.createdAt) ?? event.createdAt;
  if (
    !bookId ||
    !id ||
    !chapterId ||
    !correctionType ||
    !correctionTypes.has(correctionType) ||
    !afterJson ||
    !applyScope ||
    !correctionScopes.has(applyScope)
  ) {
    return { ok: false, message: 'user_correction_created contains an invalid correction' };
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    return { ok: false, message: 'user_correction_created requires an ISO createdAt' };
  }
  return {
    ok: true,
    bookId,
    correction: {
      ...correction,
      id,
      chapterId,
      correctionType,
      afterJson,
      applyScope,
      createdAt,
    },
  };
}

export function parseCorrectionDeletedPayload(
  event: SyncEvent,
): { ok: true; bookId: string; id: string; deletedAt: string } | { ok: false; message: string } {
  const payload = record(event.payload);
  const correction = record(payload.correction);
  const bookId =
    event.novelId ??
    stringValue(payload.bookId) ??
    stringValue(payload.novelId) ??
    stringValue(correction.novelId) ??
    stringValue(correction.bookId);
  const id = stringValue(payload.id) ?? stringValue(correction.id) ?? event.entityId;
  const deletedAt = stringValue(payload.deletedAt) ?? event.revision?.deletedAt ?? event.createdAt;
  if (!bookId || !id) {
    return {
      ok: false,
      message: 'user_correction_deleted is missing a book id or correction id',
    };
  }
  if (!Number.isFinite(Date.parse(deletedAt))) {
    return { ok: false, message: 'user_correction_deleted requires an ISO deletedAt' };
  }
  return { ok: true, bookId, id, deletedAt };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? value : undefined;
}

function parseCharacter(
  value: unknown,
  bookId: string,
): { ok: true; character: Character } | { ok: false; message: string } {
  const body = record(value);
  const id = stringValue(body.id);
  const canonicalName = stringValue(body.canonicalName);
  const aliases = stringArray(body.aliases);
  const color = stringValue(body.color);
  const confidence = numberValue(body.confidence, Number.NaN);
  if (!id || !canonicalName || !aliases || !color || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, message: 'character_graph_updated contains an invalid character' };
  }
  return {
    ok: true,
    character: {
      id,
      novelId: bookId,
      canonicalName,
      aliases,
      color,
      description: stringValue(body.description),
      confidence,
      isUserConfirmed: booleanValue(body.isUserConfirmed),
    },
  };
}

function parseCharacterRelation(
  value: unknown,
  bookId: string,
  characterIds: Set<string>,
): { ok: true; relation: CharacterRelation } | { ok: false; message: string } {
  const body = record(value);
  const id = stringValue(body.id);
  const sourceCharacterId = stringValue(body.sourceCharacterId);
  const targetCharacterId = stringValue(body.targetCharacterId);
  const relationLabel = stringValue(body.relationLabel);
  const termsUsedBySource = stringArray(body.termsUsedBySource);
  const termsUsedByTarget = stringArray(body.termsUsedByTarget);
  const evidence = body.evidence === undefined ? undefined : stringArray(body.evidence);
  const confidence = numberValue(body.confidence, Number.NaN);
  if (
    !id ||
    !sourceCharacterId ||
    !targetCharacterId ||
    sourceCharacterId === targetCharacterId ||
    !characterIds.has(sourceCharacterId) ||
    !characterIds.has(targetCharacterId) ||
    !relationLabel ||
    !termsUsedBySource ||
    !termsUsedByTarget ||
    (evidence === undefined && body.evidence !== undefined) ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return { ok: false, message: 'character_graph_updated contains an invalid relation' };
  }
  return {
    ok: true,
    relation: {
      id,
      novelId: bookId,
      sourceCharacterId,
      targetCharacterId,
      relationLabel,
      termsUsedBySource,
      termsUsedByTarget,
      confidence,
      evidence,
    },
  };
}

export function parseCharacterGraphPayload(event: SyncEvent):
  | {
      ok: true;
      bookId: string;
      mode: 'patch' | 'replace';
      characters: Character[];
      relations?: CharacterRelation[];
      updatedAt: string;
    }
  | { ok: false; message: string } {
  const payload = record(event.payload);
  const bookId = event.novelId ?? stringValue(payload.bookId) ?? stringValue(payload.novelId);
  const mode = stringValue(payload.mode) ?? 'patch';
  if (!bookId) return { ok: false, message: 'character_graph_updated is missing a book id' };
  if (!characterGraphModes.has(mode)) {
    return { ok: false, message: 'character_graph_updated mode must be patch or replace' };
  }
  if (!Array.isArray(payload.characters)) {
    return { ok: false, message: 'character_graph_updated requires a characters array' };
  }

  const characters: Character[] = [];
  for (const item of payload.characters) {
    const parsed = parseCharacter(item, bookId);
    if (!parsed.ok) return parsed;
    characters.push(parsed.character);
  }
  const characterIds = new Set(characters.map((character) => character.id));
  let relations: CharacterRelation[] | undefined;
  if (Array.isArray(payload.relations)) {
    relations = [];
    for (const item of payload.relations) {
      const parsed = parseCharacterRelation(item, bookId, characterIds);
      if (!parsed.ok) return parsed;
      relations.push(parsed.relation);
    }
  } else if (payload.relations !== undefined) {
    return {
      ok: false,
      message: 'character_graph_updated relations must be an array when provided',
    };
  }

  return {
    ok: true,
    bookId,
    mode: mode as 'patch' | 'replace',
    characters,
    relations,
    updatedAt: String(event.revision?.updatedAt ?? payload.updatedAt ?? event.createdAt),
  };
}

function parseSegment(
  value: unknown,
  bookId: string,
  chapterId: string,
): { ok: true; segment: LabeledSegment } | { ok: false; message: string } {
  const body = record(value);
  const id = stringValue(body.id);
  const paragraphId = stringValue(body.paragraphId);
  const segmentIndex = numberValue(body.segmentIndex, Number.NaN);
  const startOffset = numberValue(body.startOffset, Number.NaN);
  const endOffset = numberValue(body.endOffset, Number.NaN);
  const segmentTextHash = stringValue(body.segmentTextHash);
  const type = stringValue(body.type) as SegmentType | undefined;
  const speakerId = stringValue(body.speakerId);
  const candidateSpeakers = stringArray(body.candidateSpeakers);
  const listenerIds = stringArray(body.listenerIds);
  const confidence = numberValue(body.confidence, Number.NaN);
  const prosody = record(body.prosodyIntent);
  const segmentBookId = stringValue(body.novelId) ?? stringValue(body.bookId) ?? bookId;
  const segmentChapterId = stringValue(body.chapterId) ?? chapterId;
  if (
    !id ||
    segmentBookId !== bookId ||
    segmentChapterId !== chapterId ||
    !paragraphId ||
    !Number.isInteger(segmentIndex) ||
    segmentIndex < 0 ||
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset >= endOffset ||
    !segmentTextHash ||
    !type ||
    !segmentTypes.has(type) ||
    !speakerId ||
    !candidateSpeakers ||
    !listenerIds ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return { ok: false, message: 'chapter_segments_updated contains an invalid segment' };
  }
  return {
    ok: true,
    segment: {
      id,
      novelId: bookId,
      chapterId,
      paragraphId,
      segmentIndex,
      startOffset,
      endOffset,
      segmentTextHash,
      type,
      speakerId,
      candidateSpeakers,
      listenerIds,
      emotion: stringValue(body.emotion) ?? 'neutral',
      prosodyIntent:
        Object.keys(prosody).length > 0
          ? {
              pace: stringValue(prosody.pace),
              intensity: stringValue(prosody.intensity),
              delivery: stringValue(prosody.delivery),
            }
          : undefined,
      confidence,
      evidence: stringValue(body.evidence),
      voiceProfileId: stringValue(body.voiceProfileId),
      isUserCorrected: booleanValue(body.isUserCorrected),
    },
  };
}

export function parseChapterSegmentsPayload(event: SyncEvent):
  | {
      ok: true;
      bookId: string;
      chapterId: string;
      mode: 'patch' | 'replace';
      paragraphIds: string[];
      segments: LabeledSegment[];
      updatedAt: string;
    }
  | { ok: false; message: string } {
  const payload = record(event.payload);
  const bookId = event.novelId ?? stringValue(payload.bookId) ?? stringValue(payload.novelId);
  const chapterId = stringValue(payload.chapterId);
  const mode = stringValue(payload.mode) ?? 'replace';
  if (!bookId) return { ok: false, message: 'chapter_segments_updated is missing a book id' };
  if (!chapterId) {
    return { ok: false, message: 'chapter_segments_updated requires a chapterId' };
  }
  if (!chapterSegmentModes.has(mode)) {
    return { ok: false, message: 'chapter_segments_updated mode must be patch or replace' };
  }
  if (!Array.isArray(payload.segments)) {
    return { ok: false, message: 'chapter_segments_updated requires a segments array' };
  }
  const segments: LabeledSegment[] = [];
  for (const item of payload.segments) {
    const parsed = parseSegment(item, bookId, chapterId);
    if (!parsed.ok) return parsed;
    segments.push(parsed.segment);
  }
  const segmentParagraphIds = [...new Set(segments.map((segment) => segment.paragraphId))];
  const payloadParagraphIds = stringArrayValue(payload.paragraphIds);
  const paragraphIds =
    mode === 'patch' ? [...new Set(payloadParagraphIds.length ? payloadParagraphIds : segmentParagraphIds)] : [];
  if (mode === 'patch' && paragraphIds.length === 0) {
    return { ok: false, message: 'chapter_segments_updated patch requires paragraphIds' };
  }
  if (mode === 'patch') {
    const allowed = new Set(paragraphIds);
    if (segments.some((segment) => !allowed.has(segment.paragraphId))) {
      return {
        ok: false,
        message: 'chapter_segments_updated patch contains segments outside paragraphIds',
      };
    }
  }
  return {
    ok: true,
    bookId,
    chapterId,
    mode: mode as 'patch' | 'replace',
    paragraphIds,
    segments,
    updatedAt: String(event.revision?.updatedAt ?? payload.updatedAt ?? event.createdAt),
  };
}

function parseReaderAnchorPayload(
  event: SyncEvent,
):
  | { ok: true; bookId: string; chapterId: string; paragraphId?: string }
  | { ok: true; skip: true }
  | { ok: false; message: string } {
  const payload = record(event.payload);
  const entity =
    event.type === 'reading_position_updated'
      ? record(payload.position)
      : event.type === 'listening_position_updated'
        ? record(payload.listeningPosition)
        : event.type === 'bookmark_created'
          ? record(payload.bookmark)
          : event.type === 'highlight_created'
            ? record(payload.highlight)
            : event.type === 'note_created' || event.type === 'note_updated'
              ? record(payload.note)
              : undefined;
  if (!entity) return { ok: true, skip: true };

  const bookId = event.novelId ?? stringValue(entity.novelId) ?? stringValue(entity.bookId);
  const chapterId = stringValue(entity.chapterId);
  const anchor = record(entity.anchor);
  const paragraphId = stringValue(entity.paragraphId) ?? stringValue(anchor.paragraphId);
  if (!bookId) return { ok: false, message: `${event.type} is missing a book id` };
  if (!chapterId) return { ok: false, message: `${event.type} requires a chapterId` };
  if (event.type === 'highlight_created' && !paragraphId) {
    return { ok: false, message: 'highlight_created requires a paragraphId' };
  }
  if (event.type === 'listening_position_updated') {
    const anchorKind = stringValue(anchor.kind);
    if (!['reflowable_text', 'fixed_page', 'fixed_text'].includes(anchorKind ?? '')) {
      return { ok: false, message: 'listening_position_updated requires a supported document anchor' };
    }
    if (anchorKind === 'reflowable_text' && !paragraphId) {
      return { ok: false, message: 'reflowable listening position requires a paragraphId' };
    }
  }
  return { ok: true, bookId, chapterId, paragraphId };
}

async function validateReaderAnchorPayload(
  client: pg.PoolClient,
  event: SyncEvent,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = parseReaderAnchorPayload(event);
  if (!parsed.ok) return parsed;
  if ('skip' in parsed) return { ok: true };

  const chapter = await client.query<{ exists: boolean }>(
    'select exists(select 1 from chapters where id = $1 and book_id = $2) as exists',
    [parsed.chapterId, parsed.bookId],
  );
  if (!chapter.rows[0]?.exists) {
    return {
      ok: false,
      message: 'reader anchor chapter does not belong to the synced book',
    };
  }

  if (parsed.paragraphId) {
    const paragraph = await client.query<{ exists: boolean }>(
      'select exists(select 1 from paragraph_search where paragraph_id = $1 and book_id = $2 and chapter_id = $3) as exists',
      [parsed.paragraphId, parsed.bookId, parsed.chapterId],
    );
    if (!paragraph.rows[0]?.exists) {
      return {
        ok: false,
        message: 'reader anchor paragraph does not belong to the synced chapter',
      };
    }
  }

  return { ok: true };
}

async function validateChapterSegmentAnchors(
  client: pg.PoolClient,
  parsed: {
    bookId: string;
    chapterId: string;
    mode: 'patch' | 'replace';
    paragraphIds: string[];
    segments: LabeledSegment[];
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const chapterResult = await client.query<{ exists: boolean }>(
    'select exists(select 1 from chapters where id = $1 and book_id = $2) as exists',
    [parsed.chapterId, parsed.bookId],
  );
  if (!chapterResult.rows[0]?.exists) {
    return {
      ok: false,
      message: 'chapter_segments_updated chapter does not belong to the synced book',
    };
  }

  const paragraphIds =
    parsed.mode === 'patch'
      ? [...new Set([...parsed.paragraphIds, ...parsed.segments.map((segment) => segment.paragraphId)])]
      : [...new Set(parsed.segments.map((segment) => segment.paragraphId))];
  if (paragraphIds.length === 0) return { ok: true };
  const paragraphResult = await client.query<{ paragraph_id: string; text: string }>(
    `
      select paragraph_id, text
      from paragraph_search
      where book_id = $1
        and chapter_id = $2
        and paragraph_id = any($3::text[])
    `,
    [parsed.bookId, parsed.chapterId, paragraphIds],
  );
  const textByParagraphId = new Map(paragraphResult.rows.map((row) => [row.paragraph_id, String(row.text)]));
  if (textByParagraphId.size !== paragraphIds.length) {
    return {
      ok: false,
      message: 'chapter_segments_updated references a paragraph outside the chapter',
    };
  }
  const byParagraph = new Map<string, LabeledSegment[]>();
  for (const segment of parsed.segments) {
    const text = textByParagraphId.get(segment.paragraphId);
    if (!text || segment.endOffset > text.length) {
      return {
        ok: false,
        message: 'chapter_segments_updated contains invalid segment offsets',
      };
    }
    if (!matchesIntegrityHash(segment.segmentTextHash, text.slice(segment.startOffset, segment.endOffset))) {
      return {
        ok: false,
        message: 'chapter_segments_updated segment hash does not match paragraph text',
      };
    }
    const group = byParagraph.get(segment.paragraphId) ?? [];
    group.push(segment);
    byParagraph.set(segment.paragraphId, group);
  }
  for (const segments of byParagraph.values()) {
    const sorted = [...segments].sort(
      (left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset,
    );
    let cursor = 0;
    for (const segment of sorted) {
      if (segment.startOffset < cursor) {
        return {
          ok: false,
          message: 'chapter_segments_updated contains overlapping segments',
        };
      }
      cursor = segment.endOffset;
    }
  }
  return { ok: true };
}

export async function validateSyncEventPayload(
  client: pg.PoolClient,
  event: SyncEvent,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const readerAnchor = await validateReaderAnchorPayload(client, event);
  if (!readerAnchor.ok) return readerAnchor;
  if (event.type === 'document_annotation_updated') {
    const parsed = parseDocumentAnnotationPayload(event);
    if (!parsed.ok) return parsed;
    const page = await client.query<{ page_hash: string }>(
      'select page_hash from document_pages where book_id = $1 and page_index = $2',
      [parsed.bookId, parsed.pageIndex],
    );
    if (!page.rows[0]) return { ok: false, message: 'document annotation page does not exist in the book' };
    const anchor = record(parsed.annotation.anchor);
    const pageHash = stringValue(anchor.pageHash);
    if (pageHash && pageHash !== page.rows[0].page_hash) {
      return { ok: false, message: 'document annotation page hash does not match the synced source' };
    }
  }
  if (event.type === 'document_annotation_deleted') {
    const parsed = parseDocumentAnnotationDeletedPayload(event);
    if (!parsed.ok) return parsed;
  }
  if (event.type === 'document_text_order_override_updated') {
    const parsed = parseDocumentTextOrderOverridePayload(event);
    if (!parsed.ok) return parsed;
    const page = await client.query<{ page_hash: string }>(
      'select page_hash from document_pages where book_id = $1 and page_index = $2',
      [parsed.bookId, parsed.pageIndex],
    );
    if (!page.rows[0]) return { ok: false, message: 'document text order override page does not exist in the book' };
    if (parsed.pageHash !== page.rows[0].page_hash) {
      return { ok: false, message: 'document text order override page hash does not match the synced source' };
    }
  }
  if (event.type === 'document_text_order_override_deleted') {
    const parsed = parseDocumentTextOrderOverrideDeletedPayload(event);
    if (!parsed.ok) return parsed;
  }
  if (event.type === 'voice_profiles_updated') {
    const parsed = parseVoiceProfilesPayload(event);
    if (!parsed.ok) return parsed;
  }
  if (event.type === 'voice_casting_updated') {
    const parsed = parseVoiceCastingUpdatedPayload(event);
    if (!parsed.ok) return parsed;
  }
  if (event.type === 'user_correction_created') {
    const parsed = parseCorrectionPayload(event);
    if (!parsed.ok) return parsed;
    const result = await client.query<{ exists: boolean }>(
      'select exists(select 1 from chapters where id = $1 and book_id = $2) as exists',
      [stringValue(parsed.correction.chapterId), parsed.bookId],
    );
    if (!result.rows[0]?.exists) {
      return {
        ok: false,
        message: 'correction chapter does not belong to the synced book',
      };
    }
  }
  if (event.type === 'user_correction_deleted') {
    const parsed = parseCorrectionDeletedPayload(event);
    if (!parsed.ok) return parsed;
  }
  if (event.type === 'character_graph_updated') {
    const parsed = parseCharacterGraphPayload(event);
    if (!parsed.ok) return parsed;
  }
  if (event.type === 'chapter_segments_updated') {
    const parsed = parseChapterSegmentsPayload(event);
    if (!parsed.ok) return parsed;
    const anchors = await validateChapterSegmentAnchors(client, parsed);
    if (!anchors.ok) return anchors;
  }
  return { ok: true };
}
