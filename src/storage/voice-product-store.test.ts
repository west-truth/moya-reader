import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyVoiceProductState } from '../providers/voice-product';
import { resetReaderDbForTests } from './reader-database';
import { getVoiceProductState, saveVoiceProductState } from './voice-product-store';

describe('voice product store', () => {
  beforeEach(() => resetReaderDbForTests());

  it('returns an empty aggregate and persists a book-scoped state', async () => {
    expect((await getVoiceProductState('book')).novelId).toBe('book');
    const state = { ...emptyVoiceProductState('book'), minorFallbackEnabled: true };
    await saveVoiceProductState('book', state);
    expect(await getVoiceProductState('book')).toEqual(state);
  });
});
