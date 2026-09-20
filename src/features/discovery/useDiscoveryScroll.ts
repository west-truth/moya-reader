import { useLayoutEffect, type RefObject } from 'react';
import type { DiscoverySession } from './discovery-session';
/** Restore the same section even if earlier cached rows change height while mounting. */
export function useDiscoveryScroll(ref: RefObject<HTMLElement>, key: string, session: DiscoverySession) {
  const positions = session.scrollPositions;
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const target = positions.get(key);
    let restoring = Boolean(target);
    const capture = () => {
      const top = root.getBoundingClientRect().top;
      const row = [...root.querySelectorAll<HTMLElement>('[data-discovery-section]')].find(
        (item) => item.getBoundingClientRect().bottom > top,
      );
      positions.delete(key);
      positions.set(key, {
        id: row?.dataset.discoverySection,
        offset: row ? row.getBoundingClientRect().top - top : 0,
        top: root.scrollTop,
      });
      if (positions.size > 100) positions.delete(positions.keys().next().value!);
    };
    const restore = () => {
      if (!restoring || !target) return;
      const row = [...root.querySelectorAll<HTMLElement>('[data-discovery-section]')].find(
        (item) => item.dataset.discoverySection === target.id,
      );
      if (row) root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - target.offset;
      else root.scrollTop = target.top;
    };
    const userInput = () => {
      restoring = false;
    };
    const save = () => {
      if (!restoring) capture();
    };
    if (!target) root.scrollTop = 0;
    restore();
    const frame = requestAnimationFrame(restore);
    const observer = new ResizeObserver(restore);
    const content = root.querySelector('.discovery-sections');
    if (content) observer.observe(content);
    root.addEventListener('scroll', save, { passive: true });
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      root.addEventListener(event, userInput, { passive: true });
    return () => {
      if (!restoring) capture();
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener('scroll', save);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) root.removeEventListener(event, userInput);
    };
  }, [ref, key, positions]);
}
