import { access } from 'node:fs/promises';
import type { BrowserType } from 'playwright-core';

/** Use an installed browser; Windows WebView2 alone is not an automation browser. */
export async function launchSourceBrowser(
  launcher: Pick<BrowserType, 'launch'>,
  args: string[],
  platform = process.platform,
) {
  const configured = process.env.MOYA_SOURCE_BROWSER_EXECUTABLE;
  if (configured) return launcher.launch({ executablePath: configured, headless: true, args });
  if (platform === 'win32') {
    const failures: unknown[] = [];
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await launcher.launch({ channel, headless: true, args });
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(failures, 'source_browser_unavailable');
  }
  for (const executablePath of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) {
    if (
      await access(executablePath).then(
        () => true,
        () => false,
      )
    )
      return launcher.launch({ executablePath, headless: true, args });
  }
  return launcher.launch({ headless: true, args });
}
