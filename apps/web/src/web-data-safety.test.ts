import { describe, expect, it, vi, afterEach } from 'vitest';
import { BACKUP_REMINDER_INTERVAL, backupReminderDue, parseWebDataSafety, recordWebBackup } from './web-data-safety';

afterEach(() => vi.unstubAllGlobals());
describe('Web backup reminders', () => {
  it('does not treat a corrupt preference as a completed backup', () => {
    expect(parseWebDataSafety('broken')).toEqual({});
    expect(parseWebDataSafety('{"lastExportedAt":"yesterday","dismissedUntil":-1}')).toEqual({
      lastExportedAt: undefined,
      dismissedUntil: undefined,
    });
    expect(backupReminderDue(parseWebDataSafety('null'), 100)).toBe(true);
  });
  it('waits a week after a backup or dismissal, without claiming a backup on dismissal', () => {
    const now = Date.now();
    expect(backupReminderDue({ lastExportedAt: now }, now + BACKUP_REMINDER_INTERVAL - 1)).toBe(false);
    expect(backupReminderDue({ lastExportedAt: now }, now + BACKUP_REMINDER_INTERVAL)).toBe(true);
    expect(backupReminderDue({ dismissedUntil: now + BACKUP_REMINDER_INTERVAL }, now)).toBe(false);
    expect(backupReminderDue({}, now)).toBe(true);
  });
  it('does not fail a successful export when localStorage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => recordWebBackup(new Date().toISOString())).not.toThrow();
  });
});
