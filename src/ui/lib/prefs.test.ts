import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, loadPrefs, parsePrefs, PREFS_KEY, savePrefs, type StorageLike } from './prefs';

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('prefs', () => {
  it('defaults when nothing or garbage is stored', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{not json')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"view":{"turnHints":"yes"},"keepScreenOn":1,"dismissed":[1,"a"]}')).toEqual({ ...DEFAULT_PREFS, dismissed: ['a'] });
  });

  it('round-trips through storage', () => {
    const s = new MemStorage();
    const p = { view: { turnHints: false, connections: false, unsure: true, edgesOnly: true }, keepScreenOn: false, dismissed: ['placing-hint'] };
    savePrefs(s, p);
    expect(JSON.parse(s.getItem(PREFS_KEY)!)).toEqual(p);
    expect(loadPrefs(s)).toEqual(p);
  });

  it('never throws when storage is blocked', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs(broken, DEFAULT_PREFS)).not.toThrow();
    expect(loadPrefs(undefined)).toEqual(DEFAULT_PREFS);
  });

  it('does not share default objects between loads', () => {
    const a = loadPrefs(undefined);
    a.view.turnHints = false;
    expect(loadPrefs(undefined).view.turnHints).toBe(true);
  });
});
