export type ExternalSourceBrowseMode = 'popular' | 'latest' | 'search';

export type ExternalSourceFilterValue =
  boolean | number | string | { readonly index: number; readonly ascending: boolean };

export interface ExternalSourceFilterChange {
  readonly position: number;
  readonly groupPosition?: number;
  readonly value: ExternalSourceFilterValue;
}

export type ExternalSourceFilterDefinition =
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'header';
      readonly label: string;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'separator';
      readonly label?: string;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'checkbox';
      readonly label: string;
      readonly defaultValue: boolean;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'select';
      readonly label: string;
      readonly options: readonly string[];
      readonly defaultValue: number;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'sort';
      readonly label: string;
      readonly options: readonly string[];
      readonly defaultValue: { readonly index: number; readonly ascending: boolean };
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'text';
      readonly label: string;
      readonly defaultValue: string;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'tri_state';
      readonly label: string;
      readonly defaultValue: 'IGNORE' | 'INCLUDE' | 'EXCLUDE';
    };

export interface ExternalSourceBrowseState {
  readonly activeMode: ExternalSourceBrowseMode;
  readonly availableModes: readonly ExternalSourceBrowseMode[];
  readonly filters?: readonly ExternalSourceFilterDefinition[];
}
