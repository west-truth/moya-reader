import type {
  TTSCacheGateway,
  TTSCacheReadinessInput,
  TTSCacheRenderInput,
} from '../../features/tts/tts-cache-gateway';

export class LazyNativeTTSCacheGateway implements TTSCacheGateway {
  readonly runtime = 'native' as const;
  private delegate?: Promise<TTSCacheGateway>;

  render(input: TTSCacheRenderInput, signal: AbortSignal) {
    return this.load().then((gateway) => gateway.render(input, signal));
  }

  inspect(input: TTSCacheReadinessInput, signal?: AbortSignal) {
    return this.load().then((gateway) => gateway.inspect(input, signal));
  }

  pendingJobs() {
    return this.load().then((gateway) => gateway.pendingJobs?.() ?? []);
  }

  evidence(renderSpecHashes: readonly string[]) {
    return this.load().then((gateway) => gateway.evidence?.(renderSpecHashes) ?? []);
  }

  private load(): Promise<TTSCacheGateway> {
    this.delegate ??= import('./native-tts-cache-gateway').then(
      ({ TauriNativeTTSCacheGateway }) => new TauriNativeTTSCacheGateway(),
    );
    return this.delegate;
  }
}
