import type { SyncOutboxItem, SyncState } from '../../sync/types';

export function syncLastSyncedLabel(state: SyncState | undefined, formatDateTime: (value: string) => string): string {
  return state?.lastSyncedAt ? formatDateTime(state.lastSyncedAt) : '기록 없음';
}

export function outboxStatusLabel(status: SyncOutboxItem['status']): string {
  if (status === 'pending') return '대기';
  if (status === 'sending') return '전송 중';
  if (status === 'failed') return '실패';
  return '전송됨';
}

export function syncEventTypeLabel(type: SyncOutboxItem['event']['type']): string {
  const labels: Partial<Record<SyncOutboxItem['event']['type'], string>> = {
    book_imported: '책 가져오기',
    book_deleted: '책 삭제',
    book_updated: '책 정보',
    reading_position_updated: '읽던 위치',
    reading_position_deleted: '읽던 위치 초기화',
    bookmark_created: '북마크 추가',
    bookmark_deleted: '북마크 삭제',
    highlight_created: '하이라이트 추가',
    highlight_deleted: '하이라이트 삭제',
    note_created: '메모 추가',
    note_updated: '메모 수정',
    note_deleted: '메모 삭제',
    document_annotation_updated: '문서 주석 저장',
    document_annotation_deleted: '문서 주석 삭제',
    document_text_order_override_updated: 'PDF 읽기 순서 저장',
    document_text_order_override_deleted: 'PDF 읽기 순서 초기화',
    settings_updated: '읽기 설정',
    voice_profiles_updated: 'AI/TTS 음성 프로필',
    user_correction_created: 'AI 라벨 교정',
    user_correction_deleted: 'AI 라벨 교정 삭제',
    character_graph_updated: 'AI 인물 그래프',
    chapter_segments_updated: 'AI 화자 라벨',
  };
  return labels[type] ?? type;
}

export async function runSyncMergeAction(
  groupKey: string,
  apply: () => Promise<boolean>,
  clearSelection: (groupKey: string) => void,
): Promise<boolean> {
  const applied = await apply();
  if (applied) clearSelection(groupKey);
  return applied;
}
