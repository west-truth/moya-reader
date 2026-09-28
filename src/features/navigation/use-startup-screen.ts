import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReaderSettings } from '../../domain/types';
import { rememberNavigationViewState } from './navigation-view-state';

type StartupScreen = ReaderSettings['startupScreen'];
export function resolveStartupScreen(
  preference: StartupScreen,
  shelves: readonly { id: string }[],
  tabs: readonly { id: string; hidden?: boolean }[],
): StartupScreen {
  if (preference?.kind === 'library')
    return {
      kind: 'library',
      shelfId: shelves.some((shelf) => shelf.id === preference.shelfId) ? preference.shelfId : undefined,
    };
  if (preference?.kind === 'discovery')
    return {
      kind: 'discovery',
      tabId: tabs.find((tab) => !tab.hidden && tab.id === preference.tabId)?.id ?? tabs.find((tab) => !tab.hidden)?.id,
    };
}

/** Apply once after persisted settings and destination lists arrive, before creating app history. */
export function useStartupScreen(input: {
  ready: boolean;
  preference: StartupScreen;
  shelvesReady: boolean;
  shelves: readonly { id: string }[];
  discoveryReady: boolean;
  tabs: readonly { id: string; hidden?: boolean }[];
  discoveryScope: string;
  atLibraryRoot: boolean;
  setShelf(id?: string): void;
  openDiscovery(): void;
}) {
  const [settled, setSettled] = useState(false);
  const applied = useRef(false);
  const interacted = useRef(false);
  useEffect(() => {
    const mark = () => {
      interacted.current = true;
    };
    window.addEventListener('pointerdown', mark, { capture: true, once: true });
    window.addEventListener('keydown', mark, { capture: true, once: true });
    return () => {
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('keydown', mark, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (applied.current || !input.ready) return;
    if (!interacted.current && input.atLibraryRoot) {
      if (input.preference?.kind === 'library' && !input.shelvesReady) return;
      if (input.preference?.kind === 'discovery' && !input.discoveryReady) return;
      const target = resolveStartupScreen(input.preference, input.shelves, input.tabs);
      if (target?.kind === 'library') input.setShelf(target.shelfId);
      if (target?.kind === 'discovery') {
        rememberNavigationViewState(`discovery-tab:${input.discoveryScope}`, target.tabId ?? '');
        rememberNavigationViewState(`discovery-quick:${input.discoveryScope}`, undefined);
        input.openDiscovery();
      }
    }
    applied.current = true;
    setSettled(true);
  }, [input]);
  return settled;
}
