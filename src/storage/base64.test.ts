import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';

function bytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 131 + (i >> 7)) & 0xff;
  return out;
}

describe('base64', () => {
  it('matches Node for lengths around chunk boundaries and round-trips', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 12287, 12288, 12289, 32767, 32768, 100_003]) {
      const data = bytes(n);
      const encoded = bytesToBase64(data);
      expect(encoded).toBe(Buffer.from(data).toString('base64'));
      expect(base64ToBytes(encoded)).toEqual(data);
    }
  });

  it('handles multi-megabyte buffers', () => {
    const data = bytes(5 * 1024 * 1024 + 1);
    const back = base64ToBytes(bytesToBase64(data));
    expect(back.length).toBe(data.length);
    expect(Buffer.compare(Buffer.from(back), Buffer.from(data))).toBe(0);
  });

  it('rejects malformed input', () => {
    for (const s of ['abc', 'ab=c', '%%%%', 'ab c', 'a===']) expect(() => base64ToBytes(s)).toThrow(TypeError);
  });
});
