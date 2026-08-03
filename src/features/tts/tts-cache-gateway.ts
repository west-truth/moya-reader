import type { DesktopTTSSynthesisInput, DesktopTTSSynthesisResult } from '../../providers/desktop-tts-provider';
import type { TTSRenderSpec } from '../../providers/tts-render-spec';

export interface TTSCacheExpectedRender {
  readonly renderSpec: TTSRenderSpec;
  readonly renderSpecHash: string;
}

export interface TTSNativeRecoveryPolicy {
  readonly network: 'any' | 'unmetered';
  readonly charging: 'any' | 'required';
}

export interface TTSCacheRenderInput extends TTSCacheExpectedRender {
  readonly operationId: string;
  readonly contentRevision: string;
  readonly synthesis: DesktopTTSSynthesisInput;
  /** Reject a cache miss instead of calling the configured synthesis provider. */
  readonly cacheOnly?: boolean;
  /** Android headless retry constraints. Foreground rendering is not delayed by this policy. */
  readonly recoveryPolicy?: TTSNativeRecoveryPolicy;
}

export interface TTSCacheRenderResult {
  readonly cacheKey: string;
  readonly renderSpecHash: string;
  readonly contentRevision: string;
  readonly cacheHit: boolean;
  readonly synthesis: DesktopTTSSynthesisResult;
}

export interface TTSCacheReadinessInput {
  readonly novelId: string;
  readonly contentRevision: string;
  readonly expected: readonly TTSCacheExpectedRender[];
}

export interface TTSCacheReadiness {
  readonly ok: boolean;
  readonly planned: number;
  readonly ready: number;
  readonly missing: number;
  readonly byteSize: number;
  readonly readyRenderSpecHashes: readonly string[];
  readonly missingRenderSpecHashes: readonly string[];
  readonly evidenceHash: string;
  readonly checkedAtMs: number;
}

export interface TTSCachePruneResult {
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly removedBytes: number;
  readonly removedItems: number;
  readonly retainedItems: number;
}

export interface TTSPendingNativeRender {
  readonly operationId: string;
  readonly novelId: string;
  readonly chapterId: string;
  readonly providerId: string;
  readonly renderSpecHash: string;
  readonly state: 'running' | 'retry_wait' | 'failed';
  readonly attemptCount: number;
  readonly updatedAtMs: number;
  readonly nextAttemptAtMs: number | null;
  readonly failureKind: 'transient' | 'configuration' | null;
}

export interface TTSNativeCacheEvidence {
  readonly renderSpecHash: string;
  readonly cacheKey: string;
  readonly byteSize: number;
}

export interface TTSCacheGateway {
  readonly runtime: 'native';
  render(input: TTSCacheRenderInput, signal: AbortSignal): Promise<TTSCacheRenderResult>;
  inspect(input: TTSCacheReadinessInput, signal?: AbortSignal): Promise<TTSCacheReadiness>;
  pendingJobs?(): Promise<readonly TTSPendingNativeRender[]>;
  evidence?(renderSpecHashes: readonly string[]): Promise<readonly TTSNativeCacheEvidence[]>;
  prune?(input: {
    readonly maxBytes: number;
    readonly protectedCacheKeys: readonly string[];
  }): Promise<TTSCachePruneResult>;
}
