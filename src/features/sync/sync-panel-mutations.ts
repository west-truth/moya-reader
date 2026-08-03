import type {
  Bookmark,
  Chapter,
  Character,
  LabeledSegment,
  Novel,
  ReaderHighlight,
  ReaderNote,
  VoiceProfile,
} from '../../domain/types';
import type { CharacterRelation } from '../../providers/ai';
import {
  chapterSegmentsRevision,
  characterGraphRevision,
  voiceProfilesRevision,
} from '../../domain/resource-revisions';
import { UnsupportedRepositoryCapabilityError, type ReaderRepository } from '../../repositories/reader-repository';
import {
  buildAiTtsMergedSnapshotFromSelections,
  buildAiTtsRemoteSnapshotApplyEvents,
} from '../../sync/ai-tts-sync-apply';
import type { AiTtsSyncRemoteSnapshot } from '../../sync/ai-tts-sync-diff';
import type { AiTtsSyncConflictGroup } from '../../sync/sync-ui';
import type { ReadingPosition, SyncOutboxItem, SyncState } from '../../sync/types';

export type SyncPanelOutboxMutationRepository = Pick<
  ReaderRepository,
  'capabilities' | 'discardSyncOutboxItems' | 'listSyncOutbox'
>;

export type SyncPanelRemoteStateRepository = Pick<
  ReaderRepository,
  | 'listSyncOutbox'
  | 'listNovels'
  | 'getNovel'
  | 'listChapters'
  | 'listBookmarks'
  | 'listHighlights'
  | 'listNotes'
  | 'getReadingPosition'
  | 'getChapter'
  | 'listCharacters'
  | 'listVoiceProfiles'
  | 'listSegments'
>;

export type SyncPanelAiTtsMutationRepository = Pick<
  ReaderRepository,
  | 'saveVoiceProfiles'
  | 'saveCharacterGraph'
  | 'saveSegments'
  | 'capabilities'
  | 'applyRemoteSyncEvents'
  | 'discardSyncOutboxItems'
  | 'listSyncOutbox'
  | 'listCharacters'
  | 'listCharacterRelations'
  | 'listVoiceProfiles'
  | 'listSegments'
>;

export interface RemoteSyncStateAcceptor {
  acceptRemoteState(): Promise<SyncState>;
}

export interface SyncPanelOutboxMutationResult {
  state: SyncState;
  outbox: SyncOutboxItem[];
}

export interface DiscardSyncOutboxIdsInput {
  repository: SyncPanelOutboxMutationRepository;
  ids: string[];
}

function discardLocalOutbox(repository: SyncPanelOutboxMutationRepository, ids: string[]): Promise<SyncState> {
  const discard = repository.discardSyncOutboxItems;
  if (repository.capabilities.syncStorage !== 'local_outbox' || !discard) {
    throw new UnsupportedRepositoryCapabilityError(
      'discardSyncOutboxItems',
      'syncStorage',
      repository.capabilities.backend,
    );
  }
  return discard.call(repository, ids);
}

function applyRemoteEvents(
  repository: SyncPanelAiTtsMutationRepository,
  events: Parameters<NonNullable<ReaderRepository['applyRemoteSyncEvents']>>[0],
): Promise<void> {
  const apply = repository.applyRemoteSyncEvents;
  if (!repository.capabilities.remoteEventApply || !apply) {
    throw new UnsupportedRepositoryCapabilityError(
      'applyRemoteSyncEvents',
      'remoteEventApply',
      repository.capabilities.backend,
    );
  }
  return apply.call(repository, events);
}

export async function discardSyncOutboxIds(input: DiscardSyncOutboxIdsInput): Promise<SyncPanelOutboxMutationResult> {
  const state = await discardLocalOutbox(input.repository, input.ids);
  const outbox = await input.repository.listSyncOutbox();
  return { state, outbox };
}

export type AcceptedRemoteSelection =
  | { status: 'none' }
  | { status: 'missing' }
  | {
      status: 'loaded';
      novel: Novel;
      chapters: Chapter[];
      bookmarks: Bookmark[];
      highlights: ReaderHighlight[];
      notes: ReaderNote[];
      readingPosition?: ReadingPosition;
      currentChapter?: Chapter;
      characters: Character[];
      voiceProfiles: VoiceProfile[];
      segments: LabeledSegment[];
    };

export interface AcceptRemoteSyncStateInput {
  repository: SyncPanelRemoteStateRepository;
  remoteState: RemoteSyncStateAcceptor;
  selectedNovelId?: string;
  currentChapterId?: string;
}

export interface AcceptRemoteSyncStateResult extends SyncPanelOutboxMutationResult {
  novels: Novel[];
  selection: AcceptedRemoteSelection;
}

export async function acceptRemoteSyncState(input: AcceptRemoteSyncStateInput): Promise<AcceptRemoteSyncStateResult> {
  const state = await input.remoteState.acceptRemoteState();
  const outbox = await input.repository.listSyncOutbox();
  const novels = await input.repository.listNovels();
  if (!input.selectedNovelId) return { state, outbox, novels, selection: { status: 'none' } };

  const novel = await input.repository.getNovel(input.selectedNovelId);
  if (!novel) return { state, outbox, novels, selection: { status: 'missing' } };

  const [chapters, bookmarks, highlights, notes, readingPosition, characters, voiceProfiles] = await Promise.all([
    input.repository.listChapters(novel.id),
    input.repository.listBookmarks(novel.id),
    input.repository.listHighlights(novel.id),
    input.repository.listNotes(novel.id),
    input.repository.getReadingPosition(novel.id),
    input.repository.listCharacters(novel.id),
    input.repository.listVoiceProfiles(novel.id),
  ]);
  const currentChapter = input.currentChapterId ? await input.repository.getChapter(input.currentChapterId) : undefined;
  const segments = currentChapter ? await input.repository.listSegments(currentChapter.id) : [];

  return {
    state,
    outbox,
    novels,
    selection: {
      status: 'loaded',
      novel,
      chapters,
      bookmarks,
      highlights,
      notes,
      readingPosition,
      currentChapter,
      characters,
      voiceProfiles,
      segments,
    },
  };
}

export interface AiTtsArtifactSelection {
  selectedNovelId?: string;
  currentChapterId?: string;
  currentSegments?: LabeledSegment[];
}

export type AiTtsArtifactReloadResult =
  | { status: 'skipped' }
  | { status: 'failed'; error: string }
  | {
      status: 'loaded';
      novelId: string;
      characters: Character[];
      voiceProfiles: VoiceProfile[];
      segments: LabeledSegment[];
    };

export interface AiTtsSyncMutationResult extends SyncPanelOutboxMutationResult {
  settledOutboxIds: string[];
  artifactReload: AiTtsArtifactReloadResult;
}

interface AiTtsMutationInput {
  repository: SyncPanelAiTtsMutationRepository;
  group: AiTtsSyncConflictGroup;
  remoteSnapshot: AiTtsSyncRemoteSnapshot;
  artifactSelection?: AiTtsArtifactSelection;
}

export interface ApplyAiTtsSelectedLocalFieldsInput extends AiTtsMutationInput {
  selectedKeys: readonly string[];
}

export type ApplyAiTtsRemoteSnapshotGroupInput = AiTtsMutationInput;

function discardableOutboxIds(group: AiTtsSyncConflictGroup): string[] {
  if (group.items.some((item) => item.status === 'sending')) {
    throw new Error('AI/TTS sync group is currently sending and cannot be replaced');
  }
  const ids = group.items.filter((item) => item.status !== 'sent').map((item) => item.id);
  if (!ids.length) throw new Error('AI/TTS sync group has no discardable outbox items');
  return ids;
}

function segmentChapterId(group: AiTtsSyncConflictGroup, snapshot: AiTtsSyncRemoteSnapshot): string {
  const payload = group.items[0]?.event.payload;
  const payloadChapterId =
    payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.chapterId === 'string'
      ? payload.chapterId
      : undefined;
  const firstSegmentChapterId = snapshot.segments
    ?.map((segment) => segment.chapterId)
    .find((value): value is string => typeof value === 'string');
  const chapterId = payloadChapterId ?? firstSegmentChapterId;
  if (!chapterId) throw new Error('Merged chapter segment snapshot is missing a chapter id');
  return chapterId;
}

async function reloadSelectedAiTtsArtifacts(
  repository: SyncPanelAiTtsMutationRepository,
  novelId: string,
  selection?: AiTtsArtifactSelection,
): Promise<AiTtsArtifactReloadResult> {
  if (!selection?.selectedNovelId || selection.selectedNovelId !== novelId) return { status: 'skipped' };

  try {
    const [characters, voiceProfiles, segments] = await Promise.all([
      repository.listCharacters(novelId),
      repository.listVoiceProfiles(novelId),
      selection.currentChapterId
        ? repository.listSegments(selection.currentChapterId)
        : Promise.resolve(selection.currentSegments ?? []),
    ]);
    return { status: 'loaded', novelId, characters, voiceProfiles, segments };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

async function settleAiTtsOutbox(
  repository: SyncPanelAiTtsMutationRepository,
  settledOutboxIds: string[],
): Promise<SyncPanelOutboxMutationResult> {
  return discardSyncOutboxIds({ repository, ids: settledOutboxIds });
}

export async function applyAiTtsSelectedLocalFields(
  input: ApplyAiTtsSelectedLocalFieldsInput,
): Promise<AiTtsSyncMutationResult> {
  const mergedSnapshot = buildAiTtsMergedSnapshotFromSelections(input.group, input.remoteSnapshot, input.selectedKeys);
  const novelId = input.group.novelId;
  if (!novelId) throw new Error('AI/TTS sync group is missing a book id');
  const settledOutboxIds = discardableOutboxIds(input.group);

  if (input.group.eventType === 'voice_profiles_updated') {
    const currentProfiles = await input.repository.listVoiceProfiles(novelId);
    await input.repository.saveVoiceProfiles(
      novelId,
      (mergedSnapshot.voiceProfiles ?? []) as unknown as VoiceProfile[],
      { expectedRevision: voiceProfilesRevision(currentProfiles) },
    );
  } else if (input.group.eventType === 'character_graph_updated') {
    const [currentCharacters, currentRelations] = await Promise.all([
      input.repository.listCharacters(novelId),
      input.repository.listCharacterRelations(novelId),
    ]);
    await input.repository.saveCharacterGraph(
      novelId,
      {
        characters: (mergedSnapshot.characters ?? []) as unknown as Character[],
        relations: (mergedSnapshot.relations ?? []) as unknown as CharacterRelation[],
      },
      { expectedRevision: characterGraphRevision(currentCharacters, currentRelations) },
    );
  } else {
    const chapterId = segmentChapterId(input.group, mergedSnapshot);
    const currentSegments = await input.repository.listSegments(chapterId);
    await input.repository.saveSegments(chapterId, (mergedSnapshot.segments ?? []) as unknown as LabeledSegment[], {
      expectedRevision: chapterSegmentsRevision(currentSegments),
    });
  }

  const settled = await settleAiTtsOutbox(input.repository, settledOutboxIds);
  const artifactReload = await reloadSelectedAiTtsArtifacts(input.repository, novelId, input.artifactSelection);
  return { ...settled, settledOutboxIds, artifactReload };
}

export async function applyAiTtsRemoteSnapshotGroup(
  input: ApplyAiTtsRemoteSnapshotGroupInput,
): Promise<AiTtsSyncMutationResult> {
  const events = buildAiTtsRemoteSnapshotApplyEvents(input.group, input.remoteSnapshot);
  const novelId = input.group.novelId;
  if (!novelId) throw new Error('AI/TTS sync group is missing a book id');
  const settledOutboxIds = discardableOutboxIds(input.group);

  await applyRemoteEvents(input.repository, events);
  const settled = await settleAiTtsOutbox(input.repository, settledOutboxIds);
  const artifactReload = await reloadSelectedAiTtsArtifacts(input.repository, novelId, input.artifactSelection);
  return { ...settled, settledOutboxIds, artifactReload };
}
