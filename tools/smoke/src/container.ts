/**
 * Structural integrity of media bodies. HLS playlists carry no byte sizes, so a blob truncated
 * during upload (S3 multipart, R2, a partial copy) is served "successfully" with consistent
 * ranges; only the container structure gives it away.
 */

export interface IntegrityResult {
  ok: boolean;
  /** Top-level ISO BMFF box types, in order (fMP4/CMAF), or "ts" for MPEG-TS. */
  boxes: string[];
  problem?: string;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** Walk top-level ISO BMFF boxes: every declared size must fit, and they must tile the body. */
export function checkIsoBmff(bytes: Uint8Array): IntegrityResult {
  const boxes: string[] = [];
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    if (remaining < 8) {
      return {
        ok: false,
        boxes,
        problem: `${remaining} stray bytes after box '${boxes.at(-1) ?? "(none)"}'`,
      };
    }
    let size = view.getUint32(offset);
    const type = fourcc(bytes, offset + 4);
    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      return { ok: false, boxes, problem: `no valid box type at byte ${offset} (not ISO BMFF)` };
    }
    if (size === 1) {
      if (remaining < 16) return { ok: false, boxes, problem: `box '${type}' header is cut off` };
      size = Number(view.getBigUint64(offset + 8));
    } else if (size === 0) {
      size = remaining;
    }
    if (size < 8)
      return {
        ok: false,
        boxes,
        problem: `box '${type}' at byte ${offset} declares an invalid size ${size}`,
      };
    if (size > remaining) {
      return {
        ok: false,
        boxes: [...boxes, type],
        problem: `box '${type}' at byte ${offset} declares ${size} bytes but only ${remaining} remain: the object is truncated`,
      };
    }
    boxes.push(type);
    offset += size;
  }
  return { ok: true, boxes };
}

/** MPEG-TS: 188-byte packets, each starting with the 0x47 sync byte. */
export function checkMpegTs(bytes: Uint8Array): IntegrityResult {
  if (bytes.byteLength === 0 || bytes.byteLength % 188 !== 0) {
    return {
      ok: false,
      boxes: ["ts"],
      problem: `${bytes.byteLength} bytes is not a whole number of 188-byte packets: truncated`,
    };
  }
  for (let offset = 0; offset < bytes.byteLength; offset += 188) {
    if (bytes[offset] !== 0x47)
      return {
        ok: false,
        boxes: ["ts"],
        problem: `packet at byte ${offset} lacks the 0x47 sync byte`,
      };
  }
  return { ok: true, boxes: ["ts"] };
}

/** Pick the check by URI extension; null when the format is not one we can verify. */
export function checkMediaBody(uri: string, bytes: Uint8Array): IntegrityResult | null {
  const path = uri.split("?")[0] ?? uri;
  if (/\.(m4s|mp4|m4a|m4v|cmfv|cmfa)$/i.test(path)) {
    const result = checkIsoBmff(bytes);
    if (!result.ok) return result;
    const first = result.boxes[0] ?? "";
    const expected = /init|\.mp4$/i.test(path)
      ? ["ftyp"]
      : ["styp", "moof", "sidx", "emsg", "prft", "ftyp"];
    if (!expected.includes(first)) {
      return {
        ok: false,
        boxes: result.boxes,
        problem: `starts with box '${first}', expected ${expected.join(" or ")}`,
      };
    }
    if (/\.m4s$/i.test(path) && !(result.boxes.includes("moof") && result.boxes.includes("mdat"))) {
      return { ok: false, boxes: result.boxes, problem: "media segment lacks a moof/mdat pair" };
    }
    return result;
  }
  if (/\.ts$/i.test(path)) return checkMpegTs(bytes);
  return null;
}
