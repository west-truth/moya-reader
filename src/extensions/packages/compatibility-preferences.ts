export interface CompatibilityPreference {
  group?: string;
  disabled?: boolean;
  key: string;
  title: string;
  summary?: string;
  kind: 'text' | 'boolean' | 'select' | 'multi-select';
  secret: boolean;
  value?: string | boolean | number | string[];
  configured?: boolean;
  choices?: readonly { label: string; value: string | number }[];
}
export interface CompatibilityPreferences {
  groups?: readonly { id: string; title: string; unavailable?: boolean; unsupportedActions?: number }[];
  networkPolicy?: 'direct' | 'restricted';
  revision: number;
  fields: readonly CompatibilityPreference[];
  privateOrigins: readonly string[];
}
