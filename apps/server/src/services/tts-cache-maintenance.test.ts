import { describe, expect, it, vi } from 'vitest';
import { maintainTTSCache } from './tts-cache-maintenance.js';

describe('TTS cache maintenance', () => {
  it('marks affected rows stale and deletes only bounded unleased GC candidates', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'cache_1', audio_object_key: 'tts/cache_1.mp3' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const remove = vi.fn().mockResolvedValue(undefined);
    const result = await maintainTTSCache({ query } as never, { s3: {} } as never, { deleteAudioObject: remove });
    expect(result).toEqual({ markedStale: 2, deleted: 1, failed: 0 });
    expect(remove).toHaveBeenCalledWith('tts/cache_1.mp3');
    expect(String(query.mock.calls[0][0])).toContain('left join provider_job_attempts attempt');
    expect(String(query.mock.calls[0][0])).toContain("attempt.outcome_state = 'outcome_unknown'");
    expect(String(query.mock.calls[0][0])).not.toContain('job.outcome_state');
    expect(String(query.mock.calls[1][0])).toContain('voice_catalog_entries');
    expect(String(query.mock.calls[2][0])).toContain("then 'corrupt' else 'stale'");
    expect(String(query.mock.calls[3][0])).toContain("then 'audio_cache_ready'");
    expect(String(query.mock.calls[4][0])).toContain('limit 20');
    expect(String(query.mock.calls[4][0])).toContain('lease.expires_at > now()');
    expect(String(query.mock.calls[4][0])).toContain('for update of cache skip locked');
  });
});
