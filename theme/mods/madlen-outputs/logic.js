export const categories = [
  ['image', 'Görseller'], ['markdown', 'Markdown'], ['pdf', 'PDF'],
  ['document', 'Belgeler'], ['spreadsheet', 'Tablolar'], ['presentation', 'Sunumlar'],
  ['html', 'HTML'], ['json', 'JSON'], ['text', 'Kod ve metin'],
  ['audio', 'Ses'], ['video', 'Video'], ['archive', 'Arşivler'],
  ['folder', 'Klasörler'], ['other', 'Diğer dosyalar'],
];

export function groups(items) {
  return categories.map(([id, label]) => ({ id, label, items: items.filter(f => f.kind === id)
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)) })).filter(g => g.items.length);
}

export function targetOf(f, space, panes, terminals) {
  return f?.terminal ?? f?.agent ?? panes.find(p => p.tab === space?.tabs?.find(t => t.active)?.id && p.terminal)?.terminal
    ?? terminals.find(t => t.labels?.['herdr.chat'] === f?.pane)?.address ?? null;
}

export function visible(root) {
  const find = (n, id) => n?.id === id ? n : (n?.children ?? []).map(c => find(c, id)).find(Boolean);
  const panel = find(root, 'panel');
  return Boolean(panel && !panel.hidden && find(root, 'panel-body')?.active === 'outputs');
}

export function sizeLabel(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ageLabel(time, now = Date.now()) {
  const seconds = Math.max(0, (now / 1000) - time);
  if (seconds < 60) return 'Az önce';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} dk önce`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} sa önce`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} gün önce`;
  const date = new Date(time * 1000);
  return `${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()}`;
}
