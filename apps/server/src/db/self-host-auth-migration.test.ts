import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./migrations/0032_self_host_account_sessions.sql', import.meta.url);

describe('self-host owner account migration', () => {
  it('binds one credential owner to an existing user and never stores raw session tokens', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain('singleton_key smallint primary key');
    expect(sql).toContain('user_id text not null unique references users(id)');
    expect(sql).toContain("password_scheme text not null check (password_scheme = 'scrypt-v1')");
    expect(sql).toContain('password_salt text not null');
    expect(sql).toContain('password_digest text not null');
    expect(sql).toContain('token_hash text primary key');
    expect(sql).not.toMatch(/\bpassword\s+text\b/u);
    expect(sql).not.toMatch(/\bsession_token\b/u);
  });
});
