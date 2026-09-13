import { describe, expect, it, vi } from 'vitest';
import { DesktopGoogleSession } from './desktop-google-session';

const connected = { configured: true, accountId: 'reader', label: 'reader@example.test', driveReady: true };
describe('desktop Google account boundary', () => {
  it('restores only account metadata and coalesces concurrent token requests', async () => {
    const invoke = vi.fn(async (action: string) =>
      action === 'token' ? { ...connected, accessToken: 'test-token', expiresAt: Date.now() + 3600000 } : connected,
    );
    const session = new DesktopGoogleSession(invoke);
    await Promise.all([session.restore(), session.restore()]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(session.ready('reader')).toBe(true);
    await session.restore();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).not.toHaveProperty('accessToken');
    expect(await Promise.all([session.getAccessToken('reader'), session.getAccessToken('reader')])).toEqual([
      'test-token',
      'test-token',
    ]);
    await session.getAccessToken('reader');
    expect(invoke).toHaveBeenCalledTimes(2);
    await expect(session.getAccessToken('other')).rejects.toThrow();
  });
  it('rejects a delayed token after disconnect instead of restoring access', async () => {
    let finish!: (value: typeof connected & { accessToken: string }) => void;
    const session = new DesktopGoogleSession(async (action) =>
      action === 'token'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : connected,
    );
    await session.restore();
    const pending = session.getAccessToken('reader');
    session.invalidateDrive();
    finish({ ...connected, accessToken: 'obsolete' });
    await expect(pending).rejects.toThrow();
    expect(session.ready('reader')).toBe(false);
  });
  it('keeps login separate from Drive consent and leaves account state intact on cancellation', async () => {
    const invoke = vi.fn(async (action: string) => {
      if (action === 'connect') throw new Error('cancelled');
      return { ...connected, driveReady: false };
    });
    const session = new DesktopGoogleSession(invoke);
    await session.signIn();
    expect(session.getSnapshot().identity?.subject).toBe('reader');
    expect(session.ready('reader')).toBe(false);
    await expect(session.authorizeDrive()).rejects.toThrow('cancelled');
    expect(invoke).toHaveBeenLastCalledWith('connect', 'reader');
    expect(session.getSnapshot().identity?.subject).toBe('reader');
  });
});
