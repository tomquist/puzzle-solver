/**
 * Chunked base64 conversion for large binary payloads (multi-megabyte photos). Avoids
 * `String.fromCharCode(...hugeArray)` stack overflows and giant intermediate binary strings.
 */

/** Bytes encoded per chunk; a multiple of 3 so chunk encodings concatenate without padding. */
const ENCODE_CHUNK = 3 * 4096;
/** Characters decoded per chunk; a multiple of 4. */
const DECODE_CHUNK = 4 * 8192;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Encodes bytes as standard (padded) base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    const chunk = bytes.subarray(i, Math.min(bytes.length, i + ENCODE_CHUNK));
    parts.push(btoa(String.fromCharCode(...chunk)));
  }
  return parts.join('');
}

/** Decodes standard (padded) base64. Throws a `TypeError` on malformed input. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) throw new TypeError('Invalid base64 data');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((base64.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < base64.length; i += DECODE_CHUNK) {
    const binary = atob(base64.slice(i, i + DECODE_CHUNK));
    for (let j = 0; j < binary.length; j++) out[offset++] = binary.charCodeAt(j);
  }
  return out;
}
