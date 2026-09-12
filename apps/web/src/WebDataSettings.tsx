import { WebStoragePanel } from './WebStoragePanel';
import { WebDesktopPanel } from './WebDesktopPanel';
import { WebOfflinePanel } from './WebOfflinePanel';
import { WebBackupStatus } from './WebLibraryNotice';

export function WebDataSettings() {
  return (
    <>
      <WebOfflinePanel />
      <WebStoragePanel />
      <WebBackupStatus />
      <WebDesktopPanel />
    </>
  );
}
