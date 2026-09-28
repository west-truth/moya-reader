import { type ReactNode, useEffect, useState } from 'react';

/** Longer than the CSS exit motion so an inner Dialog/ModalDrawer can finish closing. */
const EXIT_LINGER_MS = 320;

/**
 * Mounts a conditionally rendered layer while `open`, and keeps it mounted briefly after it
 * closes. The layer must read its own open state (e.g. `<Dialog open={controller.open}>`) so it
 * animates out during that window instead of vanishing with its parent.
 */
export function LayerPresence({ open, children }: { readonly open: boolean; readonly children: ReactNode }) {
  const [wasOpen, setWasOpen] = useState(open);
  const [lingering, setLingering] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    setLingering(!open);
  }
  useEffect(() => {
    if (!lingering) return;
    const timer = setTimeout(() => setLingering(false), EXIT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [lingering]);
  return open || lingering ? <>{children}</> : null;
}
