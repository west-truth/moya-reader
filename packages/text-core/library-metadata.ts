export interface BookMetadataPatch {
  readonly title?: string;
  readonly author?: string | null;
  readonly seriesTitle?: string | null;
  readonly seriesIndex?: number | null;
  readonly tags?: readonly string[];
  readonly description?: string | null;
  readonly language?: string | null;
  readonly favorite?: boolean;
  readonly coverFit?: 'crop' | 'contain';
  readonly coverPositionX?: number;
  readonly coverPositionY?: number;
}

export interface NormalizedBookMetadataPatch {
  readonly title?: string;
  readonly author?: string | null;
  readonly seriesTitle?: string | null;
  readonly seriesIndex?: number | null;
  readonly tags?: string[];
  readonly description?: string | null;
  readonly language?: string | null;
  readonly favorite?: boolean;
  readonly coverFit?: 'crop' | 'contain';
  readonly coverPositionX?: number;
  readonly coverPositionY?: number;
}

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function optionalText(value: string | null | undefined, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

function position(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${field} must be between 0 and 100`);
  return Math.round(value * 100) / 100;
}

export function normalizeBookMetadataPatch(input: BookMetadataPatch): NormalizedBookMetadataPatch {
  const title = input.title === undefined ? undefined : input.title.trim();
  if (title !== undefined && !title) throw new Error('title is required');
  if (title && title.length > 300) throw new Error('title is too long');
  const author = optionalText(input.author, 'author', 300);
  const seriesTitle = optionalText(input.seriesTitle, 'seriesTitle', 300);
  const description = optionalText(input.description, 'description', 20_000);
  const language = optionalText(input.language, 'language', 64);
  if (language && !LANGUAGE_TAG.test(language)) throw new Error('language must be a BCP 47 language tag');
  let seriesIndex = input.seriesIndex;
  if (seriesIndex !== undefined && seriesIndex !== null) {
    if (!Number.isFinite(seriesIndex) || seriesIndex < 0 || seriesIndex > 1_000_000) {
      throw new Error('seriesIndex must be a non-negative number');
    }
    seriesIndex = Math.round(seriesIndex * 1_000) / 1_000;
  }
  let tags: string[] | undefined;
  if (input.tags !== undefined) {
    const seen = new Set<string>();
    tags = [];
    for (const value of input.tags) {
      if (typeof value !== 'string') throw new Error('tags must contain strings');
      const tag = value.trim().replace(/\s+/g, ' ');
      if (!tag) continue;
      if (tag.length > 80) throw new Error('tag is too long');
      const key = tag.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length > 50) throw new Error('too many tags');
    }
  }
  return {
    ...(title === undefined ? undefined : { title }),
    ...(author === undefined ? undefined : { author }),
    ...(seriesTitle === undefined ? undefined : { seriesTitle }),
    ...(seriesIndex === undefined ? undefined : { seriesIndex }),
    ...(tags === undefined ? undefined : { tags }),
    ...(description === undefined ? undefined : { description }),
    ...(language === undefined ? undefined : { language }),
    ...(input.favorite === undefined ? undefined : { favorite: input.favorite }),
    ...(input.coverFit === undefined ? undefined : { coverFit: input.coverFit }),
    ...(input.coverPositionX === undefined
      ? undefined
      : { coverPositionX: position(input.coverPositionX, 'coverPositionX') }),
    ...(input.coverPositionY === undefined
      ? undefined
      : { coverPositionY: position(input.coverPositionY, 'coverPositionY') }),
  };
}
