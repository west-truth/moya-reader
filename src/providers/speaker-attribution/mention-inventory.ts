import { persistentId128, structuredIntegrityHash, textIntegrityHash } from '@noveldesk/text-core/hash';
import type {
  SpeakerSourceParagraphInput,
  SpeakerSpanInventoryV1,
  SpeakerSpanV1,
} from '@noveldesk/text-core/speaker-attribution';
import type { Character } from '../../domain/types';
import type { CharacterGraphKnowledgeV2 } from '../character-graph-v2';
import { characterFactIsActiveAt, normalizeCharacterSurface, resolveCharacterRedirect } from '../character-graph-v2';

export const SOURCE_MENTION_INVENTORY_VERSION = 'source-mention-inventory-v2' as const;

export type SourceMentionType =
  | 'name'
  | 'name_variant'
  | 'title_name'
  | 'role_description'
  | 'address_name'
  | 'address_term'
  | 'pronoun'
  | 'group_entity'
  | 'generic_role';

export interface SourceMentionV1 {
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly paragraphIndex: number;
  readonly ordinal: number;
  readonly sceneId: string;
  readonly spanId: string;
  readonly spanIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly surfaceHash: string;
  readonly normalizedSurface: string;
  readonly type: SourceMentionType;
  readonly extractionCode: string;
  readonly characterId?: string;
}

export interface SourceMentionInventoryV1 {
  readonly version: typeof SOURCE_MENTION_INVENTORY_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly detectorVersion: string;
  readonly mentions: readonly SourceMentionV1[];
  readonly fingerprint: string;
}

interface KnownSurface {
  readonly surface: string;
  readonly type: 'name' | 'name_variant' | 'title_name';
  readonly characterId: string;
}

const ADDRESS_TERMS = [
  '형',
  '형님',
  '오빠',
  '누나',
  '언니',
  '선배',
  '후배',
  '폐하',
  '전하',
  '각하',
  '스승님',
  '사부',
  '여보',
  '자기야',
  '엄마',
  '아빠',
  '대표님',
  '사장님',
  '회장님',
  '팀장님',
  '실장님',
  '부장님',
  '과장님',
  '대리님',
  '배우님',
  'mother',
  'father',
  'sir',
  'maam',
] as const;
const PRONOUNS = ['그', '그녀', '그들', '이쪽', '저쪽', 'he', 'she', 'they'] as const;
const GENERIC_ROLES = [
  '남자',
  '여자',
  '아이',
  '노인',
  '기사',
  '병사',
  '점원',
  '교사',
  '의사',
  '경비',
  'the man',
  'the woman',
  'the child',
] as const;
const GROUPS = ['사람들', '병사들', '기사단', '관중', '군중', '일행', 'they all'] as const;

function knownSurfaces(
  characters: readonly Character[],
  knowledge?: CharacterGraphKnowledgeV2,
  chapterIndex?: number,
): KnownSurface[] {
  const values: KnownSurface[] = [];
  if (!knowledge) {
    for (const character of characters) {
      values.push({ surface: character.canonicalName, type: 'name', characterId: character.id });
      for (const alias of character.aliases) {
        values.push({
          surface: alias,
          type: /\s/u.test(alias) ? 'title_name' : 'name_variant',
          characterId: character.id,
        });
      }
    }
  }
  for (const fact of knowledge?.facts ?? []) {
    if (
      fact.status !== 'active' ||
      !['canonical_name', 'typed_alias'].includes(fact.field) ||
      (chapterIndex !== undefined && !characterFactIsActiveAt(fact.validity, chapterIndex))
    ) {
      continue;
    }
    values.push({
      surface: fact.value,
      type: fact.field === 'canonical_name' ? 'name' : fact.aliasType === 'title' ? 'title_name' : 'name_variant',
      characterId: resolveCharacterRedirect(fact.characterId, knowledge?.redirects ?? []),
    });
  }
  const derived = values.flatMap((value) => {
    const normalized = normalizeCharacterSurface(value.surface);
    return value.type === 'name' && /^[가-힣]{3,4}$/u.test(normalized)
      ? [value, { surface: normalized.slice(-2), type: 'name_variant' as const, characterId: value.characterId }]
      : [value];
  });
  const ownersBySurface = new Map<string, Set<string>>();
  for (const value of derived) {
    const normalized = normalizeCharacterSurface(value.surface);
    if (!normalized || normalized.length < 2) continue;
    const owners = ownersBySurface.get(normalized) ?? new Set<string>();
    owners.add(value.characterId);
    ownersBySurface.set(normalized, owners);
  }
  const unique = new Map<string, KnownSurface>();
  for (const value of derived) {
    const normalized = normalizeCharacterSurface(value.surface);
    if (!normalized || normalized.length < 2 || ownersBySurface.get(normalized)?.size !== 1) continue;
    unique.set(`${value.characterId}:${normalized}`, value);
  }
  return [...unique.values()].sort((left, right) => right.surface.length - left.surface.length);
}

function containingSpan(
  spans: readonly SpeakerSpanV1[],
  startOffset: number,
  endOffset: number,
): SpeakerSpanV1 | undefined {
  return spans.find((span) => span.startOffset <= startOffset && span.endOffset >= endOffset);
}

interface MentionCandidate {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly type: SourceMentionType;
  readonly extractionCode: string;
  readonly characterId?: string;
}

function literalCandidates(
  text: string,
  surface: string,
  details: Omit<MentionCandidate, 'startOffset' | 'endOffset'>,
) {
  const candidates: MentionCandidate[] = [];
  const haystack = text.toLocaleLowerCase();
  const needle = surface.toLocaleLowerCase();
  let from = 0;
  while (needle && from < haystack.length) {
    const startOffset = haystack.indexOf(needle, from);
    if (startOffset < 0) break;
    candidates.push({ ...details, startOffset, endOffset: startOffset + surface.length });
    from = startOffset + Math.max(1, surface.length);
  }
  return candidates;
}

function heuristicCandidates(text: string): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  for (const match of text.matchAll(
    /([가-힣]{2,5}?)(?:이|가|은|는)(?:\s+[가-힣]{1,10}){0,2}\s*(?:말했|물었|외쳤|대답했|중얼거렸|속삭였)/gu,
  )) {
    const surface = match[1]!;
    const startOffset = (match.index ?? 0) + match[0].indexOf(surface);
    const addressTerm = ADDRESS_TERMS.includes(surface as (typeof ADDRESS_TERMS)[number]);
    candidates.push({
      startOffset,
      endOffset: startOffset + surface.length,
      type: addressTerm ? 'address_term' : 'name_variant',
      extractionCode: addressTerm ? 'address_term_speech_subject' : 'speech_verb_subject',
    });
  }
  for (const match of text.matchAll(
    /([가-힣]{3})\s+(대표|사장|회장|팀장|실장|부장|과장|대리|배우|감독|변호사|의사|교수)(?:님)?/gu,
  )) {
    const name = match[1]!;
    if (/[은는이가을를에의로와과도만]$/u.test(name)) continue;
    const surface = `${name} ${match[2]!}`;
    candidates.push({
      startOffset: match.index ?? 0,
      endOffset: (match.index ?? 0) + surface.length,
      type: 'title_name',
      extractionCode: 'korean_name_title',
    });
  }
  const sender = /^([\p{L}\p{N}_ -]{2,20})\s*[:：>]\s*\S/u.exec(text.trimStart());
  if (sender) {
    const prefixOffset = text.length - text.trimStart().length;
    const startOffset = prefixOffset + sender[0].indexOf(sender[1]!);
    candidates.push({
      startOffset,
      endOffset: startOffset + sender[1]!.length,
      type: 'name_variant',
      extractionCode: 'message_sender_marker',
    });
  }
  for (const term of ADDRESS_TERMS) {
    candidates.push(...literalCandidates(text, term, { type: 'address_term', extractionCode: 'address_term_lexicon' }));
  }
  for (const pronoun of PRONOUNS) {
    candidates.push(...literalCandidates(text, pronoun, { type: 'pronoun', extractionCode: 'pronoun_lexicon' }));
  }
  for (const role of GENERIC_ROLES) {
    candidates.push(...literalCandidates(text, role, { type: 'generic_role', extractionCode: 'generic_role_lexicon' }));
  }
  for (const group of GROUPS) {
    candidates.push(...literalCandidates(text, group, { type: 'group_entity', extractionCode: 'group_lexicon' }));
  }
  return candidates;
}

export function buildSourceMentionInventory(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly paragraphs: readonly SpeakerSourceParagraphInput[];
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly characters?: readonly Character[];
  readonly graphKnowledge?: CharacterGraphKnowledgeV2;
  readonly chapterIndex?: number;
  readonly detectorVersion?: string;
}): SourceMentionInventoryV1 {
  const detectorVersion = input.detectorVersion ?? 'source-mention-detector-v6';
  const spansByParagraph = new Map<string, SpeakerSpanV1[]>();
  for (const span of input.spanInventory.spans) {
    spansByParagraph.set(span.paragraphId, [...(spansByParagraph.get(span.paragraphId) ?? []), span]);
  }
  const surfaces = knownSurfaces(input.characters ?? [], input.graphKnowledge, input.chapterIndex);
  const rows: Array<Omit<SourceMentionV1, 'id' | 'ordinal'>> = [];
  const paragraphs = [...input.paragraphs].sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  for (const paragraph of paragraphs) {
    const candidates: MentionCandidate[] = [
      ...surfaces.flatMap((surface) =>
        literalCandidates(paragraph.text, surface.surface, {
          type: surface.type,
          extractionCode: 'known_character_surface',
          characterId: surface.characterId,
        }),
      ),
      ...heuristicCandidates(paragraph.text),
    ];
    const seen = new Set<string>();
    for (const candidate of candidates.sort(
      (left, right) =>
        left.startOffset - right.startOffset ||
        right.endOffset - right.startOffset - (left.endOffset - left.startOffset),
    )) {
      const longerKnown = candidates.find(
        (known) =>
          Boolean(known.characterId) &&
          known.startOffset <= candidate.startOffset &&
          known.endOffset >= candidate.endOffset &&
          known.endOffset - known.startOffset > candidate.endOffset - candidate.startOffset,
      );
      if (longerKnown) continue;
      const exactKnown = candidate.characterId
        ? undefined
        : candidates.find(
            (known) =>
              Boolean(known.characterId) &&
              known.startOffset === candidate.startOffset &&
              known.endOffset === candidate.endOffset,
          );
      const containedKnown = candidate.characterId
        ? undefined
        : candidates.find(
            (known) =>
              Boolean(known.characterId) &&
              candidate.type === 'title_name' &&
              known.startOffset === candidate.startOffset &&
              known.endOffset < candidate.endOffset,
          );
      const resolved =
        exactKnown || containedKnown
          ? { ...candidate, characterId: (exactKnown ?? containedKnown)!.characterId }
          : candidate;
      const key = `${resolved.startOffset}:${resolved.endOffset}:${resolved.type}:${resolved.characterId ?? ''}`;
      if (seen.has(key) || resolved.endOffset <= resolved.startOffset) continue;
      const sourceSpan = containingSpan(
        spansByParagraph.get(paragraph.paragraphId) ?? [],
        resolved.startOffset,
        resolved.endOffset,
      );
      if (!sourceSpan) continue;
      seen.add(key);
      const surface = paragraph.text.slice(resolved.startOffset, resolved.endOffset);
      rows.push({
        bookId: input.bookId,
        contentRevisionId: input.contentRevisionId,
        chapterId: input.chapterId,
        paragraphId: paragraph.paragraphId,
        paragraphIndex: paragraph.paragraphIndex,
        sceneId: sourceSpan.sceneId,
        spanId: sourceSpan.id,
        spanIndex: sourceSpan.spanIndex,
        startOffset: resolved.startOffset,
        endOffset: resolved.endOffset,
        surfaceHash: textIntegrityHash(surface),
        normalizedSurface: normalizeCharacterSurface(surface),
        type: resolved.type,
        extractionCode:
          resolved.extractionCode === 'known_character_surface' && sourceSpan.type === 'narration'
            ? 'known_character_narration_surface'
            : resolved.extractionCode,
        characterId: resolved.characterId,
      });
    }
  }
  const mentions = rows.map<SourceMentionV1>((row, ordinal) => ({
    ...row,
    ordinal,
    id: persistentId128('source_mention', [
      input.contentRevisionId,
      row.paragraphId,
      String(row.startOffset),
      String(row.endOffset),
      row.type,
      row.characterId ?? '',
    ]),
  }));
  const core = {
    version: SOURCE_MENTION_INVENTORY_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    detectorVersion,
    mentions,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('source_mention_inventory', [input.contentRevisionId, input.chapterId, fingerprint]),
    fingerprint,
  };
}

export function materializeSourceMention(mention: SourceMentionV1, paragraph: SpeakerSourceParagraphInput): string {
  if (mention.paragraphId !== paragraph.paragraphId) throw new Error('Mention paragraph anchor does not match');
  const surface = paragraph.text.slice(mention.startOffset, mention.endOffset);
  if (textIntegrityHash(surface) !== mention.surfaceHash) throw new Error('Mention surface hash does not match source');
  return surface;
}
