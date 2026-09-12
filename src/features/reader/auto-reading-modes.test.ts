import { describe, expect, it, vi } from 'vitest';
import {
  AutoReadingPresentation,
  autoReadingRate,
  autoReadingSpeedLabel,
  isAutoReadingMode,
  nextReadingToken,
} from './auto-reading-modes';

describe('automatic reading modes', () => {
  it.each(['blind-pixel', 'blind-line'] as const)(
    'reveals text downwards and holds the full screen before advancing: %s',
    (mode) => {
      vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '32px' }));
      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        const presentation = new AutoReadingPresentation();
        const advance = vi.fn<(pixels: number) => 'moving' | 'waiting' | 'end'>(() => 'moving');
        const env = {
          root: { querySelector: () => null, getBoundingClientRect: () => ({ left: 0, width: 320 }) },
          overlay: { style: {}, dataset: {}, replaceChildren: vi.fn() },
          top: 64,
          bottom: 700,
          advance,
        } as unknown as Parameters<AutoReadingPresentation['advance']>[2];
        presentation.advance(mode, 0, env);
        expect(env.overlay.style.top).toBe('64px');
        expect(env.overlay.style.height).toBe('636px');
        const step = mode === 'blind-pixel' ? 64 : 1;
        presentation.advance(mode, step, env);
        const first = Number.parseFloat(env.overlay.style.top);
        presentation.advance(mode, step, env);
        const second = Number.parseFloat(env.overlay.style.top);
        expect(second).toBeGreaterThan(first);
        expect(second + Number.parseFloat(env.overlay.style.height)).toBe(700);
        advance.mockReturnValueOnce('waiting');
        presentation.advance(mode, step, env);
        expect(Number.parseFloat(env.overlay.style.top)).toBe(second);
        for (let i = 0; i < 20; i++) presentation.advance(mode, step, env);
        expect(env.overlay.style.height).toBe('0px');
        expect(advance.mock.calls.every(([pixels]) => pixels === 0)).toBe(true);
        vi.setSystemTime(1001);
        presentation.advance(mode, step, env);
        expect(advance).toHaveBeenCalledWith(604);
        expect(env.overlay.style.top).toBe('64px');
        expect(env.overlay.style.height).toBe('636px');
        presentation.reset(env.overlay);
        expect(env.overlay.hidden).toBe(true);
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
  it('invalidates delayed RSVP navigation when stopped and deduplicates its pending load', async () => {
    vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '32px' }));
    try {
      const presentation = new AutoReadingPresentation();
      let valid!: () => boolean;
      let resolve!: () => void;
      const load = vi.fn((_index: number, isCurrent: () => boolean) => {
        valid = isCurrent;
        return new Promise<void>((done) => {
          resolve = done;
        });
      });
      const env = {
        root: { querySelector: () => null, getBoundingClientRect: () => ({ left: 0, width: 320 }) },
        overlay: { style: {}, dataset: {}, replaceChildren: vi.fn() },
        top: 64,
        bottom: 700,
        count: 10,
        anchor: () => ({ blockIndex: 5, offset: 0 }),
        paragraph: () => undefined,
        load,
        advance: () => 'moving',
      } as unknown as Parameters<AutoReadingPresentation['advance']>[2];
      expect(presentation.advance('rsvp', 1, env)).toBe('waiting');
      presentation.advance('rsvp', 1, env);
      expect(load).toHaveBeenCalledOnce();
      expect(valid()).toBe(true);
      presentation.reset(env.overlay);
      expect(valid()).toBe(false);
      resolve();
      await Promise.resolve();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('uses mode-specific speeds and keeps page delay readable', () => {
    expect(autoReadingRate('pixel', 4)).toBe(20);
    expect(autoReadingRate('line', 6)).toBe(1);
    expect(autoReadingRate('blind-line', 6)).toBe(1);
    expect(autoReadingRate('page', 1)).toBe(1 / 12);
    expect(autoReadingSpeedLabel('page', 12)).toBe('1초마다');
    expect(autoReadingSpeedLabel('rsvp', 4)).toBe('분당 180어절');
    expect(isAutoReadingMode('unknown')).toBe(false);
  });
  it('retains exact offsets without normalizing whitespace, punctuation or supplementary characters', () => {
    const source = '  첫째,\t둘째!\n\n🙂끝  ';
    const tokens = [];
    let offset = 0;
    for (let token = nextReadingToken(source, offset); token; token = nextReadingToken(source, offset)) {
      tokens.push(token);
      expect(source.slice(token.start, token.end)).toBe(token.text);
      offset = token.end;
    }
    expect(tokens.map((token) => token.text)).toEqual(['첫째,', '둘째!', '🙂끝']);
    expect(nextReadingToken(source, source.length)).toBeUndefined();
  });
  it('bounds long unbroken tokens without dropping or splitting surrogate pairs', () => {
    const source = '가🙂'.repeat(100);
    let restored = '';
    let offset = 0;
    while (offset < source.length) {
      const token = nextReadingToken(source, offset)!;
      expect([...token.text].length).toBeLessThanOrEqual(24);
      restored += token.text;
      offset = token.end;
    }
    expect(restored).toBe(source);
  });
});
