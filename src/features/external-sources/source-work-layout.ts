import { readWorkView, saveWorkView, useWorkView, type WorkView } from '../../components/work-view';
export type SourceWorkLayout = WorkView;
const STORAGE_KEY = 'noveldesk.external-source-work-layout.v1';

export function readSourceWorkLayout(): SourceWorkLayout {
  return readWorkView(STORAGE_KEY);
}
export function saveSourceWorkLayout(value: SourceWorkLayout): void {
  saveWorkView(STORAGE_KEY, value);
}
export function useSourceWorkLayout() {
  return useWorkView(STORAGE_KEY);
}
