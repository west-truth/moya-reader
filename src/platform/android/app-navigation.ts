export type AppNavigationView = 'library' | 'chapters' | 'reader' | 'document';

export interface AppBackLayer {
  readonly id: string;
  readonly open: boolean;
  dismiss(): void;
}

export type AppBackResult =
  | { readonly handled: true; readonly action: 'dismiss-layer'; readonly layerId: string }
  | { readonly handled: true; readonly action: 'reader-to-chapters' }
  | { readonly handled: true; readonly action: 'chapters-to-library' }
  | { readonly handled: true; readonly action: 'document-to-library' }
  | { readonly handled: false; readonly action: 'unhandled' };

export interface AppBackNavigationInput {
  readonly layers: readonly AppBackLayer[];
  readonly view: AppNavigationView;
  returnToChapters(): void;
  returnToLibrary(): void;
}

const androidBackKeyboardEvents = new WeakSet<Event>();

export function dismissTopAppBackLayer(layers: readonly AppBackLayer[]): AppBackResult | undefined {
  const layer = layers.find((candidate) => candidate.open);
  if (!layer) return undefined;
  layer.dismiss();
  return { handled: true, action: 'dismiss-layer', layerId: layer.id };
}

export function handleAppBackNavigation(input: AppBackNavigationInput): AppBackResult {
  const dismissed = dismissTopAppBackLayer(input.layers);
  if (dismissed) return dismissed;
  if (input.view === 'reader') {
    input.returnToChapters();
    return { handled: true, action: 'reader-to-chapters' };
  }
  if (input.view === 'chapters') {
    input.returnToLibrary();
    return { handled: true, action: 'chapters-to-library' };
  }
  if (input.view === 'document') {
    input.returnToLibrary();
    return { handled: true, action: 'document-to-library' };
  }
  return { handled: false, action: 'unhandled' };
}

export interface KeyboardEventDispatchTarget {
  dispatchEvent(event: Event): boolean;
}

export function dispatchAndroidBackEscape(
  target: KeyboardEventDispatchTarget | undefined = typeof document === 'undefined' ? undefined : document,
  createEvent: (() => KeyboardEvent) | undefined = typeof KeyboardEvent === 'undefined'
    ? undefined
    : () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
): boolean {
  if (!target || !createEvent) return false;
  const event = createEvent();
  androidBackKeyboardEvents.add(event);
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

export function isAndroidBackKeyboardEvent(event: KeyboardEvent): boolean {
  return androidBackKeyboardEvents.has(event);
}

export type ReaderTransientBackAction =
  'close-overflow' | 'close-selection' | 'close-mobile-search' | 'clear-search' | 'delegate';

export function resolveReaderTransientBackAction(input: {
  readonly overflowOpen: boolean;
  readonly selectionOpen: boolean;
  readonly mobileSearchOpen: boolean;
  readonly searchActive: boolean;
}): ReaderTransientBackAction {
  if (input.overflowOpen) return 'close-overflow';
  if (input.selectionOpen) return 'close-selection';
  if (input.mobileSearchOpen) return 'close-mobile-search';
  if (input.searchActive) return 'clear-search';
  return 'delegate';
}
