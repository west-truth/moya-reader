import type { HostedTTSWarmupRequest } from '../../providers/hosted-tts-warmup';
import { ttsRenderSpecHash } from '../../providers/tts-render-spec';
import type { TTSCacheExpectedRender, TTSCacheRenderInput, TTSNativeRecoveryPolicy } from './tts-cache-gateway';

let operationSequence = 0;

export function nativeTTSOperationId(prefix = 'native_tts'): string {
  operationSequence += 1;
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${operationSequence}`;
  return `${prefix}:${nonce}`;
}

export function nativeTTSExpectedRender(request: Pick<HostedTTSWarmupRequest, 'request'>): TTSCacheExpectedRender {
  const renderSpec = request.request.renderSpec;
  if (!renderSpec) throw new Error('Native TTS cache request requires a render spec.');
  return { renderSpec, renderSpecHash: ttsRenderSpecHash(renderSpec) };
}

export function nativeTTSCacheRenderInput(
  request: Pick<HostedTTSWarmupRequest, 'request' | 'text'>,
  contentRevision: string,
  operationId = nativeTTSOperationId(),
  recoveryPolicy?: TTSNativeRecoveryPolicy,
): TTSCacheRenderInput {
  const expected = nativeTTSExpectedRender(request);
  if (expected.renderSpec.contentRevision !== contentRevision) {
    throw new Error('Native TTS render spec content revision is stale.');
  }
  return {
    ...expected,
    operationId,
    contentRevision,
    recoveryPolicy,
    synthesis: {
      providerId: request.request.providerId,
      modelId: request.request.providerModel,
      text: request.text,
      voiceId: expected.renderSpec.providerVoiceId,
      speed: expected.renderSpec.speed,
      emotion: expected.renderSpec.emotion,
      tone: expected.renderSpec.tone,
      format: expected.renderSpec.format,
      providerOptions: request.request.providerOptions,
    },
  };
}
