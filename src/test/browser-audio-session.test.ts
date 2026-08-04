import { describe, expect, it } from 'vitest';
import { BrowserAudioSession, type BrowserAudioElement } from '../providers/browser-audio-session';

class FakeAudio implements BrowserAudioElement {
  onended: HTMLAudioElement['onended'] = null;
  onerror: HTMLAudioElement['onerror'] = null;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  removedAttributes: string[] = [];

  constructor(
    readonly url: string,
    private readonly shouldRejectPlay: () => boolean = () => false,
  ) {}

  async play(): Promise<void> {
    this.playCalls += 1;
    if (this.shouldRejectPlay()) throw new Error('play rejected');
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  removeAttribute(name: string): void {
    this.removedAttributes.push(name);
  }

  load(): void {
    this.loadCalls += 1;
  }
}

function blob(): Blob {
  return new Blob(['audio'], { type: 'audio/mpeg' });
}

function fireEnded(audio: FakeAudio): void {
  (audio.onended as ((event: Event) => void) | null)?.(new Event('ended'));
}

function createHarness(options: { rejectPlay?: () => boolean } = {}) {
  let nextUrl = 0;
  const created: FakeAudio[] = [];
  const revoked: string[] = [];
  const session = new BrowserAudioSession({
    createObjectUrl: () => `blob:test-${++nextUrl}`,
    revokeObjectUrl: (url) => {
      revoked.push(url);
    },
    createAudio: (url) => {
      const audio = new FakeAudio(url, options.rejectPlay);
      created.push(audio);
      return audio;
    },
  });
  return { session, created, revoked };
}

describe('BrowserAudioSession', () => {
  it('plays a blob through an object URL and revokes it on end', async () => {
    const { session, created, revoked } = createHarness();

    const result = session.playBlob(blob());
    expect(session.hasActivePlayback).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].url).toBe('blob:test-1');

    fireEnded(created[0]);

    await expect(result).resolves.toBe(true);
    expect(session.hasActivePlayback).toBe(false);
    expect(revoked).toEqual(['blob:test-1']);
  });

  it('returns false and cleans up when playback fails', async () => {
    const { session, revoked } = createHarness({ rejectPlay: () => true });

    await expect(session.playBlob(blob())).resolves.toBe(false);
    expect(session.hasActivePlayback).toBe(false);
    expect(revoked).toEqual(['blob:test-1']);
  });

  it('pauses and resumes the active audio element', async () => {
    const { session, created } = createHarness();

    const result = session.playBlob(blob());
    session.pause();
    await expect(session.resume()).resolves.toBe(true);
    fireEnded(created[0]);

    await expect(result).resolves.toBe(true);
    expect(created[0].pauseCalls).toBe(1);
    expect(created[0].playCalls).toBe(2);
  });

  it('stops active playback, clears the source, and resolves as handled', async () => {
    const { session, created, revoked } = createHarness();

    const result = session.playBlob(blob());
    session.stop(true);

    await expect(result).resolves.toBe(true);
    expect(session.hasActivePlayback).toBe(false);
    expect(created[0].pauseCalls).toBe(1);
    expect(created[0].removedAttributes).toEqual(['src']);
    expect(created[0].loadCalls).toBe(1);
    expect(revoked).toEqual(['blob:test-1']);
  });
});
