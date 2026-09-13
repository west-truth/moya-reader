export interface BrokerAsset {
  bytes: Buffer;
  contentType: string;
}
export function createSourceBroker(
  grants: { origins: readonly string[]; allowDownloads?: boolean },
  transportOptions?: {
    authenticate?: (url: URL, signal: AbortSignal) => Promise<Record<string, string>>;
    lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
    transport?: (
      approved: { url: URL; address: { address: string; family: number } },
      request: { method: string; headers: Record<string, string>; body?: string },
      signal: AbortSignal,
    ) => Promise<{
      status: number;
      headers: Record<string, string>;
      body: import('node:stream').Readable;
    }>;
  },
): {
  methods: Record<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>;
  takeAsset(handle: string): BrokerAsset;
  dispose(): void;
};
