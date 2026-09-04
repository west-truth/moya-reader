export const EXTENSION_ENABLEMENT_SCHEMA_VERSION = 1 as const;
export const EXTENSION_ENABLEMENT_STORAGE_KEY = 'noveldesk.extensionEnablement.v1';

export interface ExtensionEnablementDocumentV1 {
  readonly schemaVersion: typeof EXTENSION_ENABLEMENT_SCHEMA_VERSION;
  readonly enabledByExtensionId: Readonly<Record<string, boolean>>;
}

export interface ExtensionEnablementStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const EXTENSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])?$/;

function validExtensionId(value: string): boolean {
  return value.includes('.') && EXTENSION_ID_PATTERN.test(value);
}

function defaultStorage(): ExtensionEnablementStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function emptyDocument(): ExtensionEnablementDocumentV1 {
  return {
    schemaVersion: EXTENSION_ENABLEMENT_SCHEMA_VERSION,
    enabledByExtensionId: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDocument(raw: string | null): ExtensionEnablementDocumentV1 {
  if (!raw) return emptyDocument();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.schemaVersion !== EXTENSION_ENABLEMENT_SCHEMA_VERSION) return emptyDocument();
    if (!isRecord(parsed.enabledByExtensionId)) return emptyDocument();

    const enabledByExtensionId: Record<string, boolean> = {};
    for (const [extensionId, enabled] of Object.entries(parsed.enabledByExtensionId)) {
      if (!validExtensionId(extensionId) || typeof enabled !== 'boolean') return emptyDocument();
      enabledByExtensionId[extensionId] = enabled;
    }
    return { schemaVersion: EXTENSION_ENABLEMENT_SCHEMA_VERSION, enabledByExtensionId };
  } catch {
    return emptyDocument();
  }
}

/** Device-local extension enablement. Storage failures degrade to an in-memory session state. */
export class ExtensionEnablementStore {
  private document?: ExtensionEnablementDocumentV1;

  constructor(private readonly storage: ExtensionEnablementStorage | null = defaultStorage()) {}

  private load(): ExtensionEnablementDocumentV1 {
    if (this.document) return this.document;
    try {
      this.document = parseDocument(this.storage?.getItem(EXTENSION_ENABLEMENT_STORAGE_KEY) ?? null);
    } catch {
      this.document = emptyDocument();
    }
    return this.document;
  }

  isEnabled(extensionId: string, defaultEnabled: boolean): boolean {
    const enabledByExtensionId = this.load().enabledByExtensionId;
    return Object.prototype.hasOwnProperty.call(enabledByExtensionId, extensionId)
      ? enabledByExtensionId[extensionId]!
      : defaultEnabled;
  }

  setEnabled(extensionId: string, enabled: boolean): void {
    if (!validExtensionId(extensionId)) throw new Error(`Invalid extension id: ${extensionId}`);
    const current = this.load();
    this.document = {
      schemaVersion: EXTENSION_ENABLEMENT_SCHEMA_VERSION,
      enabledByExtensionId: { ...current.enabledByExtensionId, [extensionId]: enabled },
    };
    try {
      this.storage?.setItem(EXTENSION_ENABLEMENT_STORAGE_KEY, JSON.stringify(this.document));
    } catch {
      // Privacy-restricted and quota-limited browsers keep the explicit choice for this app session.
    }
  }

  replaceSnapshot(snapshot: ExtensionEnablementDocumentV1): void {
    const next = parseDocument(JSON.stringify(snapshot));
    this.document = {
      schemaVersion: next.schemaVersion,
      enabledByExtensionId: { ...next.enabledByExtensionId },
    };
    try {
      this.storage?.setItem(EXTENSION_ENABLEMENT_STORAGE_KEY, JSON.stringify(this.document));
    } catch {
      // Privacy-restricted and quota-limited browsers keep the server snapshot for this app session.
    }
  }

  getSnapshot(): ExtensionEnablementDocumentV1 {
    const current = this.load();
    return {
      schemaVersion: current.schemaVersion,
      enabledByExtensionId: { ...current.enabledByExtensionId },
    };
  }
}
