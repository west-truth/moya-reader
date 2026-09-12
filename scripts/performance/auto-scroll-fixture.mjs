import './reader-position-fixture.mjs';
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutoScrollControls } from '../../src/features/reader/AutoScrollControls.tsx';
import { useAutoScroll } from '../../src/features/reader/use-auto-scroll.ts';
import '../../src/styles/shell.css';
import '../../src/styles/dialogs-import.css';
import '../../src/styles/responsive.css';

function Controls() {
  const [open, setOpen] = useState(true);
  const api = useRef();
  Object.defineProperty(api, 'current', { configurable: true, get: () => globalThis.readerFixture?.api() });
  const controller = useAutoScroll(api, 'synthetic:1', true);
  globalThis.autoFixture = { controller, setOpen };
  return React.createElement(AutoScrollControls, { controller, open, allowed: true, onClose: () => setOpen(false) });
}
const controls = document.createElement('div');
document.body.append(controls);
createRoot(controls).render(React.createElement(Controls));
