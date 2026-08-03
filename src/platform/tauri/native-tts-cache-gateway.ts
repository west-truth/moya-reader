import type { DesktopTTSSynthesisCommandResult, DesktopTTSSynthesisInput } from '../../providers/desktop-tts-provider';
import { desktopTTSSynthesisResultFromCommand } from '../../providers/desktop-tts-provider';
import { ttsRenderSpecIdentity } from '../../providers/tts-render-spec';
import type {
  TTSCacheGateway,
  TTSCacheReadiness,
  TTSCacheReadinessInput,
  TTSCachePruneResult,
  TTSCacheRenderInput,
  TTSPendingNativeRender,
  TTSNativeCacheEvidence,
} from '../../features/tts/tts-cache-gateway';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface NativeTTSCacheRenderCommandResult {
  readonly cacheKey: string;
  readonly renderSpecHash: string;
  readonly contentRevision: string;
  readonly cacheHit: boolean;
  readonly synthesis: DesktopTTSSynthesisCommandResult;
}

function synthesisRequest(input: DesktopTTSSynthesisInput): Record<string, unknown> {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    text: input.text,
    voiceId: input.voiceId,
    speed: input.speed,
    emotion: input.emotion,
    tone: input.tone,
    format: input.format,
    providerOptions: input.providerOptions ?? {},
  };
}

export class TauriNativeTTSCacheGateway implements TTSCacheGateway {
  readonly runtime = 'native' as const;
  private inspectTail = Promise.resolve();

  constructor(private readonly injectedInvoke?: TauriInvoke) {}

  async render(input: TTSCacheRenderInput, signal: AbortSignal) {
    signal.throwIfAborted();
    const invoke = await this.invoke();
    signal.throwIfAborted();
    const cancel = () => {
      void invoke('native_tts_operation_cancel', { operationId: input.operationId }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await invoke<NativeTTSCacheRenderCommandResult>('native_tts_render_cached', {
        request: {
          operationId: input.operationId,
          contentRevision: input.contentRevision,
          renderSpec: ttsRenderSpecIdentity(input.renderSpec),
          renderSpecHash: input.renderSpecHash,
          cacheOnly: input.cacheOnly ?? false,
          recoveryPolicy: input.recoveryPolicy ?? { network: 'any', charging: 'any' },
          synthesis: synthesisRequest(input.synthesis),
        },
      });
      signal.throwIfAborted();
      return {
        ...result,
        synthesis: desktopTTSSynthesisResultFromCommand(result.synthesis),
      };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async inspect(input: TTSCacheReadinessInput, signal?: AbortSignal): Promise<TTSCacheReadiness> {
    let release!: () => void;
    const previous = this.inspectTail;
    this.inspectTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      signal?.throwIfAborted();
      const invoke = await this.invoke();
      signal?.throwIfAborted();
      const result = await invoke<TTSCacheReadiness>('native_tts_cache_readiness', {
        request: {
          novelId: input.novelId,
          contentRevision: input.contentRevision,
          expected: input.expected.map((item) => ({
            renderSpec: ttsRenderSpecIdentity(item.renderSpec),
            renderSpecHash: item.renderSpecHash,
          })),
        },
      });
      signal?.throwIfAborted();
      return result;
    } finally {
      release();
    }
  }

  async prune(input: {
    readonly maxBytes: number;
    readonly protectedCacheKeys: readonly string[];
  }): Promise<TTSCachePruneResult> {
    const invoke = await this.invoke();
    return invoke<TTSCachePruneResult>('native_tts_cache_prune', {
      request: {
        maxBytes: input.maxBytes,
        protectedCacheKeys: [...input.protectedCacheKeys],
      },
    });
  }

  async pendingJobs(): Promise<readonly TTSPendingNativeRender[]> {
    const invoke = await this.invoke();
    return invoke<TTSPendingNativeRender[]>('native_tts_pending_jobs');
  }

  async evidence(renderSpecHashes: readonly string[]): Promise<readonly TTSNativeCacheEvidence[]> {
    const invoke = await this.invoke();
    return invoke<TTSNativeCacheEvidence[]>('native_tts_cache_evidence', {
      request: { renderSpecHashes: [...new Set(renderSpecHashes)] },
    });
  }

  private async invoke(): Promise<TauriInvoke> {
    if (this.injectedInvoke) return this.injectedInvoke;
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke as TauriInvoke;
  }
}
