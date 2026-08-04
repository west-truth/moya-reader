import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetReaderDbForTests } from './reader-database';
import { deleteSpokenTextRule, listSpokenTextRules, saveSpokenTextRule } from './spoken-text-rule-store';

describe('spoken text rule store', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('combines global and matching book rules in priority order', async () => {
    await saveSpokenTextRule({
      scope: 'book',
      bookId: 'book-1',
      kind: 'skip_prefix',
      pattern: '[작가의 말]',
      enabled: true,
      priority: 2,
    });
    const global = await saveSpokenTextRule({
      scope: 'global',
      kind: 'skip_line',
      pattern: '***',
      enabled: true,
      priority: 1,
    });

    expect((await listSpokenTextRules('book-1')).map((rule) => rule.pattern)).toEqual(['***', '[작가의 말]']);
    expect((await listSpokenTextRules('book-2')).map((rule) => rule.pattern)).toEqual(['***']);
    await deleteSpokenTextRule(global.id);
    expect(await listSpokenTextRules('book-2')).toEqual([]);
  });
});
