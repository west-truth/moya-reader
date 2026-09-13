import { googleVaultAdapter } from '../cloud-vault/google/google-vault-adapter';
import { desktopGoogleVaultAdapter } from './desktop-google-session';
import { detectPlatformRuntime } from './runtime';

const runtime = detectPlatformRuntime();
export const platformCloudVaultProvider =
  runtime.kind === 'tauri-desktop'
    ? desktopGoogleVaultAdapter
    : runtime.kind === 'browser'
      ? googleVaultAdapter
      : undefined;
