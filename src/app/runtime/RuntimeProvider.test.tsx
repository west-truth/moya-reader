import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import App from '../../App';
import { createAppRuntime, type AppRuntime } from './app-runtime';
import { RuntimeProvider, useAppRuntime } from './RuntimeProvider';

describe('RuntimeProvider', () => {
  it('shares one caller-owned runtime per provider and isolates provider instances', () => {
    const firstRuntime = createAppRuntime();
    const secondRuntime = createAppRuntime();
    const observed = new Map<string, AppRuntime>();

    function Probe({ id }: { id: string }) {
      observed.set(id, useAppRuntime());
      return null;
    }

    renderToStaticMarkup(
      <>
        <RuntimeProvider runtime={firstRuntime}>
          <Probe id="first-a" />
          <Probe id="first-b" />
        </RuntimeProvider>
        <RuntimeProvider runtime={secondRuntime}>
          <Probe id="second" />
        </RuntimeProvider>
      </>,
    );

    expect(observed.get('first-a')).toBe(firstRuntime);
    expect(observed.get('first-b')).toBe(firstRuntime);
    expect(observed.get('second')).toBe(secondRuntime);
    expect(secondRuntime).not.toBe(firstRuntime);
  });

  it('fails clearly when a consumer is rendered without a provider', () => {
    function Probe() {
      useAppRuntime();
      return null;
    }

    expect(() => renderToStaticMarkup(<Probe />)).toThrow('useAppRuntime must be used within RuntimeProvider.');
  });

  it('renders the library loading state through the injected composition root', () => {
    const markup = renderToStaticMarkup(
      <RuntimeProvider runtime={createAppRuntime()}>
        <App />
      </RuntimeProvider>,
    );

    expect(markup).toContain('책장을 불러오는 중입니다');
  });
});
