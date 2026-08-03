export interface MediaSessionMetadataInput {
  readonly title: string;
  readonly artist?: string;
  readonly album?: string;
  readonly artwork?: MediaImage[];
}

export interface MediaSessionHandlers {
  readonly play?: () => void;
  readonly pause?: () => void;
  readonly stop?: () => void;
  readonly previous?: () => void;
  readonly next?: () => void;
}

export interface MediaSessionAdapter {
  readonly supported: boolean;
  setMetadata(input?: MediaSessionMetadataInput): void;
  setPlaybackState(state: MediaSessionPlaybackState): void;
  setHandlers(handlers?: MediaSessionHandlers): void;
  clear(): void;
}

type BrowserMediaSession = Pick<MediaSession, 'metadata' | 'playbackState' | 'setActionHandler'>;

export class BrowserMediaSessionAdapter implements MediaSessionAdapter {
  constructor(
    private readonly session: BrowserMediaSession | undefined = typeof navigator !== 'undefined'
      ? navigator.mediaSession
      : undefined,
    private readonly Metadata: typeof MediaMetadata | undefined = typeof MediaMetadata !== 'undefined'
      ? MediaMetadata
      : undefined,
  ) {}

  get supported(): boolean {
    return Boolean(this.session && this.Metadata);
  }

  setMetadata(input?: MediaSessionMetadataInput): void {
    if (!this.session) return;
    this.session.metadata = input && this.Metadata ? new this.Metadata(input) : null;
  }

  setPlaybackState(state: MediaSessionPlaybackState): void {
    if (this.session) this.session.playbackState = state;
  }

  setHandlers(handlers?: MediaSessionHandlers): void {
    if (!this.session) return;
    const bindings: Array<[MediaSessionAction, (() => void) | undefined]> = [
      ['play', handlers?.play],
      ['pause', handlers?.pause],
      ['stop', handlers?.stop],
      ['previoustrack', handlers?.previous],
      ['nexttrack', handlers?.next],
    ];
    for (const [action, handler] of bindings) {
      try {
        this.session.setActionHandler(action, handler ? () => handler() : null);
      } catch {
        // Some browsers expose Media Session but reject individual actions.
      }
    }
  }

  clear(): void {
    this.setHandlers();
    this.setPlaybackState('none');
    this.setMetadata();
  }
}
