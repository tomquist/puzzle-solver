import { describe, expect, it } from 'vitest';
import { lockPageScroll } from './scrollLock';

describe('lockPageScroll', () => {
  it('unlocks once every lock is released, in any order', () => {
    const body = { style: { overflow: '' } };
    const fullscreen = lockPageScroll(body);
    const sheet = lockPageScroll(body); // Details opened from the full-screen view
    expect(body.style.overflow).toBe('hidden');
    fullscreen();
    expect(body.style.overflow).toBe('hidden');
    sheet();
    expect(body.style.overflow).toBe('');
  });

  it('ignores a second release and restores what was there before', () => {
    const body = { style: { overflow: 'clip' } };
    const a = lockPageScroll(body);
    a();
    a();
    const b = lockPageScroll(body);
    expect(body.style.overflow).toBe('hidden');
    b();
    expect(body.style.overflow).toBe('clip');
  });
});
