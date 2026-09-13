import { useCallback, useEffect, useRef } from 'react';
import { useNavigationViewState } from '../navigation/navigation-view-state';

/** Follow the reading chapter once per visit; subsequent browsing belongs to the user. */
export function useReadingChapterPage(
  key: string,
  currentIndex: number,
  count: number,
  pageSize: number,
  ready = true,
) {
  const [remembered, remember] = useNavigationViewState(key, 1);
  const visit = useRef({ key, settled: false });
  if (visit.current.key !== key) visit.current = { key, settled: false };
  const followCurrent = !visit.current.settled && ready && currentIndex >= 0;
  const requested = followCurrent ? Math.floor(currentIndex / pageSize) + 1 : remembered;
  const page = Math.max(1, Math.min(requested, Math.max(1, Math.ceil(count / pageSize))));

  useEffect(() => {
    if (followCurrent) visit.current.settled = true;
    // A downloaded subset is not the final catalog: neither settle nor persist its clamped page.
    if (ready && count > 0 && page !== remembered) remember(page);
  }, [count, followCurrent, key, page, ready, remember, remembered]);

  const choosePage = useCallback(
    (next: number) => {
      visit.current.settled = true;
      remember(next);
    },
    [remember],
  );
  return [page, choosePage] as const;
}
