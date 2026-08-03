import type { SyncOutboxItem, SyncState } from './types';
import { buildAiTtsSyncSnapshotPreview, type AiTtsSyncSnapshotPreview } from './ai-tts-sync-diff';
import { formatCount } from '../utils/format';

export type ReaderView = 'library' | 'chapters' | 'reader' | 'document';
export type SyncStatusTone = 'local' | 'ready' | 'pending' | 'syncing' | 'warning' | 'danger';

export const REMOTE_AUTO_REFRESH_INTERVAL_MS = 30_000;

export interface SyncOutboxSummary {
  pendingCount: number;
  sendingCount: number;
  failedCount: number;
  unsentCount: number;
  latestError?: string;
}

export type AiTtsSyncEventType =
  | 'voice_profiles_updated'
  | 'user_correction_created'
  | 'user_correction_deleted'
  | 'character_graph_updated'
  | 'chapter_segments_updated';

export interface AiTtsSyncConflictSummary extends SyncOutboxSummary {
  items: SyncOutboxItem[];
  eventCounts: Record<AiTtsSyncEventType, number>;
}

export interface AiTtsSyncConflictGroup extends SyncOutboxSummary {
  key: string;
  eventType: AiTtsSyncEventType;
  entityId: string;
  novelId?: string;
  items: SyncOutboxItem[];
  title: string;
  policyLabel: string;
  policyDescription: string;
  recommendedAction: string;
  canDiscard: boolean;
  snapshotPreview: AiTtsSyncSnapshotPreview;
}

const aiTtsSyncEventLabels: Record<AiTtsSyncEventType, string> = {
  voice_profiles_updated: '음성 프로필',
  user_correction_created: '라벨 교정',
  user_correction_deleted: '라벨 교정 삭제',
  character_graph_updated: '인물 그래프',
  chapter_segments_updated: '화자 라벨',
};

function isNewerTimestamp(candidate: string, current?: string): boolean {
  if (!current) return true;
  const candidateTime = Date.parse(candidate);
  const currentTime = Date.parse(current);
  if (Number.isNaN(candidateTime) || Number.isNaN(currentTime)) return candidate !== current;
  return candidateTime > currentTime;
}

export function canRunSyncAction(input: {
  backendMode: 'local' | 'remote';
  hasSyncService: boolean;
  syncFlushing: boolean;
  state?: SyncState;
}): boolean {
  return (input.backendMode === 'remote' || input.hasSyncService) &&
    !input.syncFlushing &&
    input.state?.status !== 'syncing';
}

export function syncActionLabel(input: {
  backendMode: 'local' | 'remote';
  syncFlushing: boolean;
  state?: SyncState;
}): string {
  const busy = input.syncFlushing || input.state?.status === 'syncing';
  if (input.backendMode === 'remote') return busy ? '새로고침 중' : '서버 새로고침';
  return busy ? '동기화 중' : '지금 동기화';
}

export function syncStatusLabel(state?: SyncState): string {
  if (!state || state.mode === 'local_only') return '로컬 전용';
  if (state.status === 'idle' && state.pendingCount === 0) return '서버 연결됨';
  if (state.status === 'syncing') return '동기화 중';
  if (state.status === 'offline') return `오프라인 · 대기 ${formatCount(state.pendingCount)}`;
  if (state.status === 'conflict') return `충돌 · 대기 ${formatCount(state.pendingCount)}`;
  if (state.status === 'failed') return `동기화 실패 · 대기 ${formatCount(state.pendingCount)}`;
  return `동기화 대기 ${formatCount(state.pendingCount)}`;
}

export function syncStatusTone(state?: SyncState): SyncStatusTone {
  if (!state || state.mode === 'local_only') return 'local';
  if (state.status === 'idle' && state.pendingCount === 0) return 'ready';
  if (state.status === 'syncing') return 'syncing';
  if (state.status === 'offline') return 'warning';
  if (state.status === 'conflict' || state.status === 'failed') return 'danger';
  return 'pending';
}

export function syncStatusTitle(state?: SyncState): string {
  if (!state) return '동기화 상태 확인 중';
  if (state.mode === 'local_only') return '로컬 전용 모드';
  if (state.status === 'idle' && state.pendingCount === 0) return '서버와 동기화됨';
  if (state.status === 'syncing') return '서버 동기화 중';
  if (state.status === 'offline') return '서버에 연결할 수 없음';
  if (state.status === 'conflict') return '동기화 충돌 감지';
  if (state.status === 'failed') return '동기화 실패';
  return '서버 전송 대기 중';
}

export function syncStatusDescription(state: SyncState | undefined, canSync: boolean, backendMode: string): string {
  if (backendMode === 'remote') return '서버 호스팅 모드입니다. 책장, 본문, 독서 상태를 API에서 직접 읽고 저장합니다.';
  if (!canSync) return '이 빌드는 로컬 저장소만 사용합니다. 서버 주소가 설정되면 로컬 변경 기록을 서버로 동기화할 수 있습니다.';
  if (!state) return '동기화 상태를 불러오고 있습니다.';
  if (state.status === 'offline') return '네트워크 또는 서버가 응답하지 않아 변경을 로컬 대기열에 보존했습니다.';
  if (state.status === 'conflict') return '서버와 로컬 변경이 충돌해 대기열을 보존했습니다. 대기열을 확인한 뒤 재시도하거나 서버 상태를 기준으로 정리하세요.';
  if (state.status === 'failed') return '마지막 동기화가 실패했습니다. 변경은 로컬 대기열에 남아 있습니다.';
  if (state.status === 'syncing') return '로컬 변경을 전송하고 서버 변경을 가져오는 중입니다.';
  if (state.pendingCount > 0) return '로컬 변경이 서버 전송을 기다리고 있습니다.';
  return '대기 중인 변경이 없습니다.';
}

export function summarizeSyncOutbox(items: SyncOutboxItem[]): SyncOutboxSummary {
  const unsent = items.filter((item) => item.status !== 'sent');
  return {
    pendingCount: unsent.filter((item) => item.status === 'pending').length,
    sendingCount: unsent.filter((item) => item.status === 'sending').length,
    failedCount: unsent.filter((item) => item.status === 'failed').length,
    unsentCount: unsent.length,
    latestError: unsent.find((item) => item.lastError)?.lastError,
  };
}

export function isAiTtsSyncEventType(type: SyncOutboxItem['event']['type']): type is AiTtsSyncEventType {
  return type === 'voice_profiles_updated' ||
    type === 'user_correction_created' ||
    type === 'user_correction_deleted' ||
    type === 'character_graph_updated' ||
    type === 'chapter_segments_updated';
}

export function aiTtsSyncEventLabel(type: AiTtsSyncEventType): string {
  return aiTtsSyncEventLabels[type];
}

export function summarizeAiTtsSyncConflicts(items: SyncOutboxItem[]): AiTtsSyncConflictSummary {
  const aiItems = items.filter((item) => item.status !== 'sent' && isAiTtsSyncEventType(item.event.type));
  const base = summarizeSyncOutbox(aiItems);
  return {
    ...base,
    items: aiItems,
    eventCounts: {
      voice_profiles_updated: aiItems.filter((item) => item.event.type === 'voice_profiles_updated').length,
      user_correction_created: aiItems.filter((item) => item.event.type === 'user_correction_created').length,
      user_correction_deleted: aiItems.filter((item) => item.event.type === 'user_correction_deleted').length,
      character_graph_updated: aiItems.filter((item) => item.event.type === 'character_graph_updated').length,
      chapter_segments_updated: aiItems.filter((item) => item.event.type === 'chapter_segments_updated').length,
    },
  };
}

export function aiTtsSyncConflictDescription(summary: AiTtsSyncConflictSummary): string | undefined {
  if (summary.unsentCount <= 0) return undefined;
  const parts = (Object.entries(summary.eventCounts) as Array<[AiTtsSyncEventType, number]>)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${aiTtsSyncEventLabel(type)} ${formatCount(count)}개`);
  return `AI/TTS 변경 ${formatCount(summary.unsentCount)}개가 서버 확인을 기다립니다${parts.length ? `: ${parts.join(', ')}` : '.'}`;
}

function aiTtsConflictEntityId(item: SyncOutboxItem): string {
  return item.event.revision?.entityId ?? item.event.entityId ?? item.event.id;
}

function aiTtsConflictNovelId(item: SyncOutboxItem): string | undefined {
  return item.event.revision?.novelId ?? item.event.novelId;
}

function aiTtsConflictPolicy(type: AiTtsSyncEventType): Pick<AiTtsSyncConflictGroup, 'policyLabel' | 'policyDescription' | 'recommendedAction'> {
  if (type === 'voice_profiles_updated') {
    return {
      policyLabel: '컬렉션 교체',
      policyDescription: '책의 음성 프로필 목록을 통째로 갱신하는 변경입니다. 서버가 더 최신이면 로컬 프로필 변경을 폐기하고, 로컬 변경이 맞으면 다시 저장한 뒤 재전송합니다.',
      recommendedAction: '서버 음성 설정이 맞으면 이 묶음을 폐기하고, 로컬 설정이 맞으면 동기화를 재시도하세요.',
    };
  }
  if (type === 'user_correction_created') {
    return {
      policyLabel: '교정 힌트 추가',
      policyDescription: '사용자가 고친 화자/감정 힌트를 추가하는 변경입니다. 서버 라벨이 이미 바뀐 경우 현재 라벨을 확인한 뒤 필요한 교정을 다시 저장하는 편이 안전합니다.',
      recommendedAction: '서버 라벨이 맞으면 이 교정 요청을 폐기하고, 로컬 교정이 필요하면 재시도하거나 같은 교정을 다시 저장하세요.',
    };
  }
  if (type === 'user_correction_deleted') {
    return {
      policyLabel: '교정 힌트 삭제',
      policyDescription: '사용자 교정 힌트를 삭제하는 변경입니다. 서버에 같은 교정이 남아 있으면 삭제 이벤트가 그 교정을 제거하고, 더 최신 교정이면 서버가 거부합니다.',
      recommendedAction: '서버 교정 힌트를 지우는 것이 맞으면 동기화를 재시도하고, 서버 교정을 유지하려면 이 삭제 요청을 폐기하세요.',
    };
  }
  if (type === 'character_graph_updated') {
    return {
      policyLabel: '인물 그래프 병합',
      policyDescription: '생성된 인물 그래프 snapshot입니다. 서버 materialization은 사용자 확인 인물 필드를 보존하지만, 동일 인물 판단은 서버 상태와 함께 확인해야 합니다.',
      recommendedAction: '서버 그래프가 맞으면 이 묶음을 폐기하고, 로컬 분석 결과가 더 맞으면 graph merge를 다시 실행하세요.',
    };
  }
  return {
    policyLabel: '화자 라벨 교체',
    policyDescription: '생성된 화자 라벨 snapshot입니다. 서버는 paragraph anchor, text hash, overlap을 검증하고 사용자 교정 라벨을 보존합니다.',
    recommendedAction: '서버 라벨이 맞으면 이 묶음을 폐기하고, 로컬 생성 라벨이 더 맞으면 해당 화의 라벨링/repair를 다시 실행하세요.',
  };
}

export function summarizeAiTtsSyncConflictGroups(items: SyncOutboxItem[]): AiTtsSyncConflictGroup[] {
  const groups = new Map<string, SyncOutboxItem[]>();
  for (const item of items) {
    if (item.status === 'sent' || !isAiTtsSyncEventType(item.event.type)) continue;
    const entityId = aiTtsConflictEntityId(item);
    const novelId = aiTtsConflictNovelId(item) ?? '';
    const key = `${item.event.type}:${novelId}:${entityId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return Array.from(groups.entries()).map(([key, groupItems]) => {
    const sortedItems = [...groupItems].sort((a, b) => a.localSequence - b.localSequence);
    const first = sortedItems[0];
    const eventType = first.event.type as AiTtsSyncEventType;
    const base = summarizeSyncOutbox(sortedItems);
    const policy = aiTtsConflictPolicy(eventType);
    return {
      ...base,
      key,
      eventType,
      entityId: aiTtsConflictEntityId(first),
      novelId: aiTtsConflictNovelId(first),
      items: sortedItems,
      title: aiTtsSyncEventLabel(eventType),
      ...policy,
      canDiscard: sortedItems.every((item) => item.status !== 'sending'),
      snapshotPreview: buildAiTtsSyncSnapshotPreview({
        eventType,
        entityId: aiTtsConflictEntityId(first),
        novelId: aiTtsConflictNovelId(first),
        items: sortedItems,
      }),
    };
  }).sort((a, b) => {
    if (a.failedCount !== b.failedCount) return b.failedCount - a.failedCount;
    return a.items[0].localSequence - b.items[0].localSequence;
  });
}

function objectPayload(item: SyncOutboxItem): Record<string, unknown> {
  return item.event.payload && typeof item.event.payload === 'object' && !Array.isArray(item.event.payload)
    ? item.event.payload as Record<string, unknown>
    : {};
}

function payloadString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function shortSyncId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...`;
}

export function syncOutboxTargetLabel(item: SyncOutboxItem): string {
  const payload = objectPayload(item);
  const bookId = item.event.novelId ?? payloadString(payload, ['novelId', 'bookId']);
  const entityId = item.event.entityId ?? payloadString(payload, ['entityId', 'id']);
  const parts = [
    bookId ? `책 ${shortSyncId(bookId)}` : undefined,
    entityId && entityId !== bookId ? `항목 ${shortSyncId(entityId)}` : undefined,
    item.event.deviceId ? `기기 ${shortSyncId(item.event.deviceId)}` : undefined,
  ].filter((part): part is string => Boolean(part));

  return parts.length ? parts.join(' · ') : '대상 정보 없음';
}

function syncEntityTypeLabel(type: NonNullable<SyncOutboxItem['event']['revision']>['entityType']): string {
  if (type === 'book') return '책';
  if (type === 'reading_position') return '읽기 위치';
  if (type === 'bookmark') return '북마크';
  if (type === 'highlight') return '하이라이트';
  if (type === 'note') return '메모';
  if (type === 'voice_profiles') return '음성 프로필';
  if (type === 'user_correction') return '라벨 교정';
  if (type === 'character_graph') return '인물 그래프';
  if (type === 'chapter_segments') return '화자 라벨';
  return '설정';
}

export function syncOutboxRevisionLabel(item: SyncOutboxItem): string {
  const revision = item.event.revision;
  if (!revision) return `로컬 순번 ${formatCount(item.localSequence)}`;
  const action = revision.deletedAt ? '삭제' : '수정';
  return `${syncEntityTypeLabel(revision.entityType)} ${action} · 로컬 #${formatCount(revision.localSequence)}`;
}

export function syncConflictResolutionDescription(state: SyncState | undefined, summary: SyncOutboxSummary): string | undefined {
  if (!state || state.status !== 'conflict' || summary.unsentCount <= 0) return undefined;
  const failed = summary.failedCount > 0 ? `실패 ${formatCount(summary.failedCount)}개` : undefined;
  const pending = summary.pendingCount > 0 ? `대기 ${formatCount(summary.pendingCount)}개` : undefined;
  const sending = summary.sendingCount > 0 ? `전송 중 ${formatCount(summary.sendingCount)}개` : undefined;
  const detail = [failed, pending, sending].filter(Boolean).join(', ');
  return `서버 상태로 정리하면 서버 변경을 먼저 가져온 뒤 남은 로컬 대기열 ${formatCount(summary.unsentCount)}개${detail ? `(${detail})` : ''}를 전송 완료로 처리합니다. 로컬 변경보다 서버 상태를 우선할 때만 사용하세요.`;
}

export function shouldRunRemoteAutoRefresh(input: {
  backendMode: 'local' | 'remote';
  syncFlushing: boolean;
  importBusy: boolean;
  state?: SyncState;
}): boolean {
  return input.backendMode === 'remote' &&
    !input.syncFlushing &&
    !input.importBusy &&
    input.state?.status !== 'syncing';
}

export function shouldOfferRemoteReadingPosition(input: {
  backendMode: 'local' | 'remote';
  view: ReaderView;
  remotePosition?: {
    chapterId: string;
    chapterProgress: number;
    updatedAt: string;
  };
  currentChapterId?: string;
  currentChapterProgress?: number;
  currentPositionUpdatedAt?: string;
  progressTolerance?: number;
}): boolean {
  if (input.backendMode !== 'remote') return false;
  if (input.view !== 'reader') return false;
  if (!input.remotePosition) return false;
  if (!isNewerTimestamp(input.remotePosition.updatedAt, input.currentPositionUpdatedAt)) return false;
  if (!input.currentChapterId) return true;
  if (input.remotePosition.chapterId !== input.currentChapterId) return true;

  const tolerance = input.progressTolerance ?? 0.015;
  return Math.abs(input.remotePosition.chapterProgress - (input.currentChapterProgress ?? 0)) > tolerance;
}
