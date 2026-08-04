import { describe, expect, it, vi } from 'vitest';
import { runSyncMergeAction } from './sync-panel-model';
import { clearSyncMergeSelection, updateSyncMergeSelection } from './useSyncMergeSelections';

describe('sync panel merge state', () => {
  it('keeps selections across feature rerenders and removes an empty group', () => {
    const selected = updateSyncMergeSelection({}, 'voice-group', 'voice_1:providerVoiceId', true);
    expect(selected).toEqual({ 'voice-group': { 'voice_1:providerVoiceId': true } });
    expect(updateSyncMergeSelection(selected, 'voice-group', 'voice_1:providerVoiceId', false)).toEqual({});
    expect(clearSyncMergeSelection(selected, 'voice-group')).toEqual({});
  });

  it('clears a group only after a successful apply', async () => {
    const clear = vi.fn();
    expect(await runSyncMergeAction('voice-group', async () => false, clear)).toBe(false);
    expect(clear).not.toHaveBeenCalled();

    expect(await runSyncMergeAction('voice-group', async () => true, clear)).toBe(true);
    expect(clear).toHaveBeenCalledWith('voice-group');
  });
});
