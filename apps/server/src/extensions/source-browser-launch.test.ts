import type { Browser } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchSourceBrowser } from './source-browser-launch.js';

afterEach(() => vi.unstubAllEnvs());

describe('installed source browser', () => {
  it('uses Chrome when Edge is missing or cannot start', async () => {
    vi.stubEnv('MOYA_SOURCE_BROWSER_EXECUTABLE', '');
    const browser = {} as Browser;
    const launch = vi.fn().mockRejectedValueOnce(new Error('Edge missing')).mockResolvedValueOnce(browser);
    expect(await launchSourceBrowser({ launch }, [], 'win32')).toBe(browser);
    expect(launch.mock.calls.map(([options]) => options.channel)).toEqual(['msedge', 'chrome']);
  });

  it('preserves an explicit browser selection and its failure', async () => {
    vi.stubEnv('MOYA_SOURCE_BROWSER_EXECUTABLE', 'custom-browser.exe');
    const launch = vi.fn().mockRejectedValue(new Error('custom failure'));
    await expect(launchSourceBrowser({ launch }, [], 'win32')).rejects.toThrow('custom failure');
    expect(launch).toHaveBeenCalledExactlyOnceWith({ executablePath: 'custom-browser.exe', headless: true, args: [] });
  });

  it('retains both launch errors when neither browser is usable', async () => {
    vi.stubEnv('MOYA_SOURCE_BROWSER_EXECUTABLE', '');
    const failure = new Error('cannot launch');
    const launch = vi.fn().mockRejectedValue(failure);
    await expect(launchSourceBrowser({ launch }, [], 'win32')).rejects.toMatchObject({
      message: 'source_browser_unavailable',
      errors: [failure, failure],
    });
  });
});
