import { describe, expect, it } from 'vitest';
import { nextMenuItemIndex } from './use-menu-popover';

describe('nextMenuItemIndex', () => {
  it('wraps arrow navigation and supports first/last shortcuts', () => {
    expect(nextMenuItemIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextMenuItemIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(nextMenuItemIndex(1, 3, 'Home')).toBe(0);
    expect(nextMenuItemIndex(1, 3, 'End')).toBe(2);
  });
});
