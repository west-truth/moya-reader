export interface ApkMetadata {
  pkg: string;
  entry: string;
  code: number;
  version: string;
  signers: string[];
}
export interface ApkSource {
  contentKind?: 'text' | 'images';
  id: string;
  name: string;
  lang: string;
}
export interface ApkRecord extends ApkMetadata {
  stateId?: string;
  activation?: string;
  digest: string;
  enabled?: boolean;
  sources: ApkSource[];
  previousDigest?: string;
}
export function apkStateDirectory(root: string, record: { pkg: string; stateId?: string }): string;
export interface ApkReview extends ApkMetadata {
  id: string;
  revision: number;
  digest: string;
}
export interface ApkInventory {
  version: 1;
  revision: number;
  packages: ApkRecord[];
}
export interface ApkTools {
  inspect(path: string, signal: AbortSignal): Promise<ApkMetadata>;
  convert(path: string, target: string, signal: AbortSignal): Promise<void>;
  describe(path: string, metadata: ApkMetadata, state: string, signal: AbortSignal): Promise<ApkSource[]>;
  changed?(pkg: string): void;
}
export class ApkInstallations {
  readonly root: string;
  constructor(root: string, tools: ApkTools);
  open(): Promise<this>;
  snapshot(): ApkInventory;
  inspect(
    bytes: Uint8Array,
    advertised: { pkg: string; code: number; version: string } | undefined,
    signal?: AbortSignal,
  ): Promise<ApkReview>;
  install(id: string, revision: number, signal?: AbortSignal): Promise<ApkInventory>;
  discard(id: string): void;
  remove(pkg: string, revision: number): Promise<void>;
  setEnabled(pkg: string, enabled: boolean, revision: number): Promise<void>;
  updatePreferences(pkg: string, revision: number, save: (record: ApkRecord) => Promise<void>): Promise<void>;
}
