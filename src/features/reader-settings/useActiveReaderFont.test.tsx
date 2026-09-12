import { useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { useActiveReaderFont } from './useActiveReaderFont';

it('commits each built-in family together with its selected font id', () => {
  const commits: string[] = [];
  function Probe({ id }: { id: string }) {
    const font = useActiveReaderFont(undefined, id);
    useLayoutEffect(() => {
      commits.push(`${id}:${font.family}`);
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe id="builtin-serif" />);
  });
  for (const name of ['sans', 'mono', 'serif']) {
    commits.length = 0;
    act(() => renderer.update(<Probe id={`builtin-${name}`} />));
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((value) => value === `builtin-${name}:var(--font-${name})`)).toBe(true);
  }
  act(() => renderer.unmount());
});
