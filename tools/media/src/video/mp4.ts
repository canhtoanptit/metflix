/**
 * Just enough ISO-BMFF parsing to check presentation timing of what we package: the first
 * presented sample of each track, for fragmented MP4 (init segment + first media fragment: `tfdt`
 * and `trun` composition offsets) and for progressive MP4 (`stts`/`ctts`), both corrected by the
 * track's edit list. Players start at the first presented frame; when that is not 0, hls.js sees a
 * start gap and some browsers stall on it, so the packager fails the asset instead of shipping it.
 */

interface Box {
  type: string;
  /** Offset of the box header. */
  start: number;
  /** Offset of the payload (after size/type/largesize). */
  body: number;
  end: number;
}

function* children(buf: Uint8Array, start: number, end: number): Generator<Box> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...buf.subarray(offset + 4, offset + 8));
    let body = offset + 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      body = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < 8 || offset + size > end) return;
    yield { type, start: offset, body, end: offset + size };
    offset += size;
  }
}

function child(buf: Uint8Array, parent: Box | null, type: string): Box | null {
  for (const box of children(buf, parent?.body ?? 0, parent?.end ?? buf.byteLength)) {
    if (box.type === type) return box;
  }
  return null;
}

function all(buf: Uint8Array, parent: Box | null, type: string): Box[] {
  return [...children(buf, parent?.body ?? 0, parent?.end ?? buf.byteLength)].filter(
    (box) => box.type === type,
  );
}

function path(buf: Uint8Array, from: Box | null, types: readonly string[]): Box | null {
  let box = from;
  for (const type of types) {
    box = child(buf, box, type);
    if (!box) return null;
  }
  return box;
}

const dataView = (buf: Uint8Array) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

export interface TrackInfo {
  id: number;
  handler: "vide" | "soun" | string;
  /** Media timescale (mdhd). */
  timescale: number;
  /** Edit list: media time where presentation starts (samples before it are not shown)… */
  mediaTime: number;
  /** …after this initial empty edit (a delay), in seconds. */
  delaySec: number;
  box: Box;
}

function tracks(buf: Uint8Array): TrackInfo[] {
  const moov = child(buf, null, "moov");
  if (!moov) return [];
  const movieTimescale = (() => {
    const mvhd = child(buf, moov, "mvhd");
    if (!mvhd) return 1000;
    const view = dataView(buf);
    return view.getUint8(mvhd.body) === 1
      ? view.getUint32(mvhd.body + 20)
      : view.getUint32(mvhd.body + 12);
  })();
  return all(buf, moov, "trak").map((trak) => {
    const view = dataView(buf);
    const tkhd = child(buf, trak, "tkhd");
    const id = tkhd ? view.getUint32(tkhd.body + (view.getUint8(tkhd.body) === 1 ? 20 : 12)) : 0;
    const mdhd = path(buf, trak, ["mdia", "mdhd"]);
    const timescale = mdhd
      ? view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12))
      : 1;
    const hdlr = path(buf, trak, ["mdia", "hdlr"]);
    const handler = hdlr ? String.fromCharCode(...buf.subarray(hdlr.body + 8, hdlr.body + 12)) : "";
    let mediaTime = 0;
    let delaySec = 0;
    const elst = path(buf, trak, ["edts", "elst"]);
    if (elst) {
      const version = view.getUint8(elst.body);
      const count = view.getUint32(elst.body + 4);
      let offset = elst.body + 8;
      for (let i = 0; i < count; i += 1) {
        const duration = version === 1 ? Number(view.getBigUint64(offset)) : view.getUint32(offset);
        const start =
          version === 1 ? Number(view.getBigInt64(offset + 8)) : view.getInt32(offset + 4);
        offset += version === 1 ? 20 : 12;
        if (start === -1) {
          // Empty edit: the track starts `duration` (movie timescale) late.
          delaySec += duration / movieTimescale;
          continue;
        }
        mediaTime = start;
        break;
      }
    }
    return { id, handler, timescale, mediaTime, delaySec, box: trak };
  });
}

/** When the earliest composed sample is shown, after the edit list (samples before the edit's
 * media time, such as AAC priming, are cut, so presentation never starts before the edit). */
function presented(track: TrackInfo, earliest: number): number {
  return (Math.max(earliest, track.mediaTime) - track.mediaTime) / track.timescale + track.delaySec;
}

export interface TrackStart {
  handler: string;
  timescale: number;
  /** First presented sample, in seconds, after the edit list. */
  firstPresentationSec: number;
  /** Raw values, for reports: decode time of the first sample and its composition offset. */
  baseDecodeTime: number;
  firstCompositionOffset: number;
  /** Sum of sample durations in the fragment / file (seconds). */
  durationSec: number;
}

/** Presentation start of each track of a fragmented MP4: init segment + one media fragment. */
export function fragmentStarts(init: Uint8Array, fragment: Uint8Array): TrackStart[] {
  const info = new Map(tracks(init).map((track) => [track.id, track]));
  const defaults = new Map<number, number>();
  const trex = path(init, null, ["moov", "mvex"]);
  if (trex) {
    for (const box of all(init, trex, "trex")) {
      const view = dataView(init);
      defaults.set(view.getUint32(box.body + 4), view.getUint32(box.body + 12));
    }
  }
  const starts: TrackStart[] = [];
  for (const moof of all(fragment, null, "moof")) {
    for (const traf of all(fragment, moof, "traf")) {
      const view = dataView(fragment);
      const tfhd = child(fragment, traf, "tfhd");
      if (!tfhd) continue;
      const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
      const trackId = view.getUint32(tfhd.body + 4);
      let cursor = tfhd.body + 8;
      if (tfhdFlags & 0x1) cursor += 8;
      if (tfhdFlags & 0x2) cursor += 4;
      let defaultDuration = defaults.get(trackId) ?? 0;
      if (tfhdFlags & 0x8) defaultDuration = view.getUint32(cursor);
      const tfdt = child(fragment, traf, "tfdt");
      const base = tfdt
        ? view.getUint8(tfdt.body) === 1
          ? Number(view.getBigUint64(tfdt.body + 4))
          : view.getUint32(tfdt.body + 4)
        : 0;
      const track = info.get(trackId);
      if (!track || starts.some((start) => start.handler === track.handler)) continue;
      let decode = base;
      let earliest = Number.POSITIVE_INFINITY;
      let firstOffset = 0;
      for (const trun of all(fragment, traf, "trun")) {
        const version = view.getUint8(trun.body);
        const flags = view.getUint32(trun.body) & 0xffffff;
        const count = view.getUint32(trun.body + 4);
        let offset = trun.body + 8;
        if (flags & 0x1) offset += 4;
        if (flags & 0x4) offset += 4;
        for (let i = 0; i < count; i += 1) {
          let duration = defaultDuration;
          let composition = 0;
          if (flags & 0x100) {
            duration = view.getUint32(offset);
            offset += 4;
          }
          if (flags & 0x200) offset += 4;
          if (flags & 0x400) offset += 4;
          if (flags & 0x800) {
            composition = version === 1 ? view.getInt32(offset) : view.getUint32(offset);
            offset += 4;
          }
          if (decode === base && i === 0) firstOffset = composition;
          earliest = Math.min(earliest, decode + composition);
          decode += duration;
        }
      }
      starts.push({
        handler: track.handler,
        timescale: track.timescale,
        firstPresentationSec: presented(track, earliest),
        baseDecodeTime: base,
        firstCompositionOffset: firstOffset,
        durationSec: (decode - base) / track.timescale,
      });
    }
  }
  return starts;
}

/** Presentation start of each track of a progressive MP4 (looks at the first 64 samples). */
export function progressiveStarts(file: Uint8Array): TrackStart[] {
  const view = dataView(file);
  return tracks(file).map((track) => {
    const stbl = path(file, track.box, ["mdia", "minf", "stbl"]);
    const durations: number[] = [];
    let total = 0;
    const stts = stbl ? child(file, stbl, "stts") : null;
    if (stts) {
      const count = view.getUint32(stts.body + 4);
      for (let i = 0; i < count; i += 1) {
        const samples = view.getUint32(stts.body + 8 + i * 8);
        const delta = view.getUint32(stts.body + 12 + i * 8);
        total += samples * delta;
        for (let s = 0; s < samples && durations.length < 64; s += 1) durations.push(delta);
      }
    }
    const offsets: number[] = [];
    const ctts = stbl ? child(file, stbl, "ctts") : null;
    if (ctts) {
      const version = view.getUint8(ctts.body);
      const count = view.getUint32(ctts.body + 4);
      for (let i = 0; i < count && offsets.length < 64; i += 1) {
        const samples = view.getUint32(ctts.body + 8 + i * 8);
        const value =
          version === 1
            ? view.getInt32(ctts.body + 12 + i * 8)
            : view.getUint32(ctts.body + 12 + i * 8);
        for (let s = 0; s < samples && offsets.length < 64; s += 1) offsets.push(value);
      }
    }
    let decode = 0;
    let earliest = Number.POSITIVE_INFINITY;
    durations.forEach((duration, index) => {
      earliest = Math.min(earliest, decode + (offsets[index] ?? 0));
      decode += duration;
    });
    if (!Number.isFinite(earliest)) earliest = 0;
    return {
      handler: track.handler,
      timescale: track.timescale,
      firstPresentationSec: presented(track, earliest),
      baseDecodeTime: 0,
      firstCompositionOffset: offsets[0] ?? 0,
      durationSec: total / track.timescale,
    };
  });
}
