import type { ExternalSourceBrowseState } from './source-browse';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const position = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 512;
const text = (v: unknown) => typeof v === 'string' && v.length <= 2000;
export function validFilterChanges(v: unknown): boolean {
  return (
    v === undefined ||
    (Array.isArray(v) &&
      v.length <= 512 &&
      v.every(
        (c) =>
          object(c) &&
          position(c.position) &&
          (c.groupPosition === undefined || position(c.groupPosition)) &&
          (typeof c.value === 'boolean' ||
            text(c.value) ||
            position(c.value) ||
            (object(c.value) && position(c.value.index) && typeof c.value.ascending === 'boolean')),
      ))
  );
}
export function validSourceBrowse(v: unknown): v is ExternalSourceBrowseState | undefined {
  if (v === undefined) return true;
  if (
    !object(v) ||
    !['popular', 'latest', 'search'].includes(String(v.activeMode)) ||
    !Array.isArray(v.availableModes) ||
    !v.availableModes.length ||
    v.availableModes.length > 3 ||
    !v.availableModes.every((m) => ['popular', 'latest', 'search'].includes(m))
  )
    return false;
  if (v.filters === undefined) return true;
  return (
    Array.isArray(v.filters) &&
    v.filters.length <= 512 &&
    v.filters.every((f) => {
      if (
        !object(f) ||
        !text(f.id) ||
        !text(f.label ?? '') ||
        !position(f.position) ||
        (f.groupPosition !== undefined && !position(f.groupPosition))
      )
        return false;
      const options = () =>
        Array.isArray(f.options) && f.options.length > 0 && f.options.length <= 512 && f.options.every(text);
      const index = (n: unknown) => position(n) && (n as number) < (f.options as unknown[]).length;
      switch (f.kind) {
        case 'header':
        case 'separator':
          return true;
        case 'text':
          return text(f.defaultValue);
        case 'checkbox':
          return typeof f.defaultValue === 'boolean';
        case 'tri_state':
          return ['IGNORE', 'INCLUDE', 'EXCLUDE'].includes(String(f.defaultValue));
        case 'select':
          return options() && index(f.defaultValue);
        case 'sort':
          return (
            options() &&
            object(f.defaultValue) &&
            index(f.defaultValue.index) &&
            typeof f.defaultValue.ascending === 'boolean'
          );
        default:
          return false;
      }
    })
  );
}
