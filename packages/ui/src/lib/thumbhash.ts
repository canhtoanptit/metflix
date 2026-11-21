import { thumbHashToDataURL } from "thumbhash";

const cache = new Map<string, string | null>();
const MAX_ENTRIES = 600;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Decode a base64 ThumbHash into a tiny PNG data URL for blur-up placeholders. Memoised: rows
 * re-render often and the same artwork appears in many rows.
 */
export function thumbhashToDataUrl(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const cached = cache.get(hash);
  if (cached !== undefined) return cached;
  let url: string | null = null;
  try {
    url = thumbHashToDataURL(base64ToBytes(hash));
  } catch {
    url = null;
  }
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(hash, url);
  return url;
}
