/** Formatting helpers (pure). */

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const yesterday = new Date(now - 86_400_000).toDateString() === d.toDateString();
  if (yesterday) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** File-system friendly name for exports. */
export function safeFileName(name: string, ext: string): string {
  const base = name.trim().replace(/[^\p{L}\p{N}\-_. ]+/gu, '').replace(/\s+/g, '-').slice(0, 60) || 'puzzle';
  return `${base}.${ext}`;
}

/** Parse a positive number from a form field ('' / invalid → undefined). */
export function parsePositive(s: string): number | undefined {
  const v = Number(s.replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}
