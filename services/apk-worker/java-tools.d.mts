import type { ApkTools, ApkMetadata } from './installations.mjs';
export interface JavaApkTools extends ApkTools {
  worker(
    path: string,
    metadata: ApkMetadata,
    state: string,
  ): {
    readonly busy: boolean;
    request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    close(): void;
  };
}
export function createJavaApkTools(
  java: string,
  build: string,
  options?: { systemRoot?: string },
): Promise<JavaApkTools>;
