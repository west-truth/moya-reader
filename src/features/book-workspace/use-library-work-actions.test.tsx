import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { LibraryManagementController } from '../library/useLibraryManagementController';
import { useLibraryWorkActions } from './use-library-work-actions';

it('opens a source chapter picker for download without starting an import, and persists streamed edits', async () => {
  const work = { id: 'stream', title: '작품', shelfIds: ['old'] };
  const openSubscription = vi.fn(async () => undefined);
  const updateLibraryMetadata = vi.fn(async () => undefined);
  const importSelected = vi.fn();
  const sources = {
    libraryWorks: [work],
    openSubscription,
    updateLibraryMetadata,
    importSelected,
  } as unknown as ExternalSourceController;
  const management = { shelves: [], memberships: [] } as unknown as LibraryManagementController;
  let actions!: ReturnType<typeof useLibraryWorkActions>;
  let renderer!: ReactTestRenderer;
  let open = false;
  function Harness() {
    actions = useLibraryWorkActions({ ...sources, open }, management);
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => actions.downloadExternal(work.id));
  expect(openSubscription).toHaveBeenCalledExactlyOnceWith(work);
  expect(importSelected).not.toHaveBeenCalled();
  expect(actions.downloadRequest?.workId).toBe(work.id);
  await act(async () => actions.renameExternal(work.id));
  await actions.dialog!.props.edit.save('새 제목');
  expect(updateLibraryMetadata).toHaveBeenLastCalledWith(work.id, { title: '새 제목' });
  await act(async () => actions.moveExternalToShelf(work.id));
  await actions.dialog!.props.edit.save('normal');
  expect(updateLibraryMetadata).toHaveBeenLastCalledWith(work.id, { shelfIds: ['normal'] });
  await actions.dialog!.props.edit.save('');
  expect(updateLibraryMetadata).toHaveBeenLastCalledWith(work.id, { shelfIds: [] });
  open = true;
  await act(async () => renderer.update(<Harness />));
  open = false;
  await act(async () => renderer.update(<Harness />));
  expect(actions.downloadRequest).toBeUndefined();
  await act(async () => renderer.unmount());
});
