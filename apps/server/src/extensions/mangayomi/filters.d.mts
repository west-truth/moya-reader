import type {
  ExternalSourceFilterChange,
  ExternalSourceFilterDefinition,
} from '../../../../../packages/extension-contracts/source-browse';
export function mangayomiFilters(
  filters: unknown[],
  changes?: readonly ExternalSourceFilterChange[],
): ExternalSourceFilterDefinition[];
