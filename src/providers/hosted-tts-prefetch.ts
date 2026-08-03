import { hostedTTSRequestKey } from '../domain/identity/tts-identities';
import type { TTSCacheResolveInput } from './provider-jobs';

export interface HostedTTSPrefetchedAudio {
  readonly cacheKey: string;
  readonly blob: Blob;
}

export function hostedTTSCacheRequestKey(chapterId: string, request: TTSCacheResolveInput): string {
  return hostedTTSRequestKey(chapterId, request);
}

export class HostedTTSPrefetchCache {
  private readonly entries = new Map<string, HostedTTSPrefetchedAudio>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = 4) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  remember(key: string, entry: HostedTTSPrefetchedAudio): void {
    if (this.maxEntries <= 0) return;
    if (!this.entries.has(key)) this.order.push(key);
    this.entries.set(key, entry);
    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift();
      if (oldest) this.entries.delete(oldest);
    }
  }

  take(key: string): HostedTTSPrefetchedAudio | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    const index = this.order.indexOf(key);
    if (index >= 0) this.order.splice(index, 1);
    return entry;
  }

  clear(): void {
    this.entries.clear();
    this.order.splice(0);
  }
}
