import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./migrations/0026_voice_casting.sql', import.meta.url);
const legacyVoiceProductRouteUrl = new URL('../routes/ai/voice-product-routes.ts', import.meta.url);

describe('voice casting migration', () => {
  it('defines an authoritative per-user/per-book aggregate with cascade ownership', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toMatch(/create table if not exists voice_casting_states/iu);
    expect(sql).toMatch(/user_id text not null references users\(id\) on delete cascade/iu);
    expect(sql).toMatch(/book_id text not null references library_books\(id\) on delete cascade/iu);
    expect(sql).toMatch(/primary key \(user_id, book_id\)/iu);
    expect(sql).toMatch(/version text not null check \(version = 'voice-casting-v1'\)/iu);
  });

  it('separates complete, user-authored, and derived payloads behind a positive integer revision', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toMatch(/revision integer not null check \(revision > 0\)/iu);
    expect(sql).toMatch(/state_payload jsonb not null check \(jsonb_typeof\(state_payload\) = 'object'\)/iu);
    expect(sql).toMatch(
      /user_authored_payload jsonb not null check \(jsonb_typeof\(user_authored_payload\) = 'object'\)/iu,
    );
    expect(sql).toMatch(/derived_payload jsonb not null check \(jsonb_typeof\(derived_payload\) = 'object'\)/iu);
  });

  it('adds idempotent revision and updated-time indexes', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toMatch(/create index if not exists idx_voice_casting_states_book_revision/iu);
    expect(sql).toMatch(/on voice_casting_states\(user_id, book_id, revision\)/iu);
    expect(sql).toMatch(/create index if not exists idx_voice_casting_states_updated/iu);
    expect(sql).toMatch(/on voice_casting_states\(user_id, updated_at desc\)/iu);
  });

  it('keeps legacy whole-replacement writes outside the authoritative table', async () => {
    const legacyRoute = await readFile(legacyVoiceProductRouteUrl, 'utf8');

    expect(legacyRoute).not.toMatch(/voice_casting_states/iu);
  });
});
