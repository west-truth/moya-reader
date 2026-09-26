import { createContext } from 'react';
import type { EmbeddedServerConnection } from './EmbeddedServerGate';
import type { EmbeddedSharingStatus } from './EmbeddedServerSharing';

/** Available only inside the trusted desktop host, never the external server page. */
export const EmbeddedAccessContext = createContext<
  | {
      connection: EmbeddedServerConnection;
      status: EmbeddedSharingStatus;
    }
  | undefined
>(undefined);
