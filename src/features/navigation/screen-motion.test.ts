import { describe, expect, it } from 'vitest';
import { screenMotionBetween } from './screen-motion';

describe('screenMotionBetween', () => {
  const library = { key: 'library', depth: 0 };
  const discovery = { key: 'discovery', depth: 0 };
  const book = { key: 'chapters:a', depth: 1 };
  const reader = { key: 'reader:a', depth: 2 };

  it('does not animate the first screen or a repeated screen', () => {
    expect(screenMotionBetween(undefined, library)).toBeUndefined();
    expect(screenMotionBetween(library, { ...library })).toBeUndefined();
  });

  it('pushes deeper screens and pops shallower ones', () => {
    expect(screenMotionBetween(library, book)).toBe('forward');
    expect(screenMotionBetween(book, reader)).toBe('forward');
    expect(screenMotionBetween(reader, book)).toBe('back');
    expect(screenMotionBetween(book, library)).toBe('back');
  });

  it('cross-fades between sibling screens', () => {
    expect(screenMotionBetween(library, discovery)).toBe('fade');
    expect(screenMotionBetween(book, { key: 'chapters:b', depth: 1 })).toBe('fade');
  });
});
