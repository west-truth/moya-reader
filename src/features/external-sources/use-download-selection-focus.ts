import { useEffect, useRef, type RefObject } from 'react';

export interface DownloadSelectionRequest {
  readonly workId: string;
  readonly sequence: number;
}

/** Menu downloads open the existing chapter picker without starting an all-chapter download. */
export function useDownloadSelectionFocus(
  root: RefObject<HTMLElement | null>,
  request: DownloadSelectionRequest | undefined,
  workId: string | undefined,
  loading: boolean,
  itemCount: number,
) {
  const applied = useRef<DownloadSelectionRequest>();
  useEffect(() => {
    if (!request || applied.current === request || request.workId !== workId || loading) return;
    const panel = root.current?.querySelector<HTMLElement>('.source-hub-release-panel');
    if (!panel) return;
    panel.scrollIntoView({ block: 'start' });
    panel.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)')?.focus({ preventScroll: true });
    applied.current = request;
  }, [root, request, workId, loading, itemCount]);
}
