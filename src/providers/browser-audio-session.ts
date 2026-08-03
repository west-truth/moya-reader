export interface BrowserAudioElement {
  onended: HTMLAudioElement['onended'];
  onerror: HTMLAudioElement['onerror'];
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  volume?: number;
}

export interface BrowserAudioSessionDependencies {
  readonly createAudio: (url: string) => BrowserAudioElement;
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
}

interface ActiveBrowserAudio {
  readonly audio: BrowserAudioElement;
  readonly url: string;
  readonly resolve: (played: boolean) => void;
  settled: boolean;
}

export class BrowserAudioSession {
  private active?: ActiveBrowserAudio;
  private volume = 1;

  constructor(
    private readonly dependencies: BrowserAudioSessionDependencies = createDefaultBrowserAudioSessionDependencies(),
  ) {}

  get hasActivePlayback(): boolean {
    return this.active !== undefined;
  }

  async playBlob(blob: Blob): Promise<boolean> {
    this.stop(true);
    let url: string | undefined;
    let audio: BrowserAudioElement;
    try {
      url = this.dependencies.createObjectUrl(blob);
      audio = this.dependencies.createAudio(url);
      audio.volume = this.volume;
    } catch {
      if (url) this.revoke(url);
      return false;
    }

    return new Promise((resolve) => {
      const active: ActiveBrowserAudio = { audio, url, resolve, settled: false };
      this.active = active;
      audio.onended = () => this.finish(active, true);
      audio.onerror = () => this.finish(active, false);
      try {
        void audio.play().catch(() => this.finish(active, false));
      } catch {
        this.finish(active, false);
      }
    });
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
    if (this.active) this.active.audio.volume = this.volume;
  }

  pause(): void {
    this.active?.audio.pause();
  }

  async resume(): Promise<boolean> {
    const audio = this.active?.audio;
    if (!audio) return false;
    try {
      await audio.play();
      return true;
    } catch {
      return false;
    }
  }

  stop(played = true): void {
    const active = this.active;
    if (!active) return;
    this.finish(active, played, true);
  }

  private finish(active: ActiveBrowserAudio, played: boolean, clearSource = false): void {
    if (active.settled) return;
    active.settled = true;
    active.audio.onended = null;
    active.audio.onerror = null;
    if (clearSource) {
      active.audio.pause();
      active.audio.removeAttribute('src');
      active.audio.load();
    }
    if (this.active === active) this.active = undefined;
    this.revoke(active.url);
    active.resolve(played);
  }

  private revoke(url: string): void {
    try {
      this.dependencies.revokeObjectUrl(url);
    } catch {
      // Object URL cleanup must not turn playback completion into a user-visible TTS error.
    }
  }
}

function createDefaultBrowserAudioSessionDependencies(): BrowserAudioSessionDependencies {
  return {
    createAudio: (url) => new Audio(url),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  };
}
