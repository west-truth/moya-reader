import { WebStoragePanel } from './WebStoragePanel';
import { WebDesktopPanel } from './WebDesktopPanel';

export function WebDataSettings() {
  return (
    <>
      <WebStoragePanel />
      <WebDesktopPanel />
    </>
  );
}
