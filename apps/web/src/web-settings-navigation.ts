let nextPanel: 'sync' | 'storage' = 'sync';
export function requestWebStoragePanel() {
  nextPanel = 'storage';
}
export function takeWebSettingsPanel(): 'sync' | 'storage' {
  return nextPanel;
}
export function resetWebSettingsPanel() {
  nextPanel = 'sync';
}
