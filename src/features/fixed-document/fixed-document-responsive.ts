export const FIXED_DOCUMENT_SIDEBAR_DESKTOP_MIN_WIDTH = 1_280;

export function fixedDocumentSidebarStartsOpen(viewportWidth: number): boolean {
  return viewportWidth >= FIXED_DOCUMENT_SIDEBAR_DESKTOP_MIN_WIDTH;
}
