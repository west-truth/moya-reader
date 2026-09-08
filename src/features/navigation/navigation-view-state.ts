import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type SetStateAction } from 'react';

const values = new Map<string, unknown>();
function remember(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  values.delete(key);
  values.set(key, value);
  if (values.size > 200) values.delete(values.keys().next().value!);
}

/** Bounded, tab-local presentation only; no imported text or reader position. */
export function useNavigationViewState<T>(
  key: string,
  initial: T | (() => T),
): [T, (value: SetStateAction<T>) => void] {
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const read = useCallback(
    () =>
      values.has(key)
        ? (values.get(key) as T)
        : typeof initialRef.current === 'function'
          ? (initialRef.current as () => T)()
          : initialRef.current,
    [key],
  );
  const [state, setState] = useState(() => ({ key, value: read() }));
  const value = state.key === key ? state.value : read();
  const updateValue = useCallback(
    (update: SetStateAction<T>) =>
      setState((current) => {
        const previous = current.key === key ? current.value : read();
        const next = typeof update === 'function' ? (update as (value: T) => T)(previous) : update;
        remember(key, next);
        return { key, value: next };
      }),
    [key, read],
  );
  return [value, updateValue];
}

export function useNavigationScroll(ref: RefObject<HTMLElement>, key: string, ready = true): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !ready) return;
    const storageKey = `scroll:${key}`;
    const target = Number(values.get(storageKey) ?? 0);
    let restoring = true;
    const save = () => {
      if (!restoring) remember(storageKey, element.scrollTop);
    };
    element.addEventListener('scroll', save, { passive: true });
    element.scrollTop = target;
    const frame = requestAnimationFrame(() => {
      element.scrollTop = target;
      restoring = false;
    });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', save);
    };
  }, [key, ready, ref]);
}
