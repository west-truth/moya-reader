/** Host settings: source code cannot read or modify these options. */
export interface SourceNetworkSettings {
  revision: number;
  defaultProxy: string;
  origin: 'environment' | 'settings' | 'direct';
}
export interface SourceNetworkSettingsRequest {
  revision: number;
  /** Empty means direct; null restores the operator's environment default. */
  defaultProxy: string | null;
}
