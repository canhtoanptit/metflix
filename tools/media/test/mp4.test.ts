import { describe, expect, it } from "vitest";
import { fragmentStarts } from "../src/video/mp4.ts";

/** Build an ISO-BMFF box. */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(new TextEncoder().encode(type), 4);
  let offset = 8;
  for (const part of payload) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => {
    view.setInt32(index * 4, value | 0);
  });
  return out;
}

/** Init segment with one track: id, handler, timescale and an optional edit list. */
function init(handler: string, timescale: number, elst?: [number, number][]): Uint8Array {
  const tkhd = box("tkhd", u32(0, 0, 0, 1));
  const mdhd = box("mdhd", u32(0, 0, 0, timescale, 0));
  const hdlr = box("hdlr", u32(0, 0), new TextEncoder().encode(handler), u32(0, 0, 0, 0));
  const edts = elst
    ? [box("edts", box("elst", u32(0, elst.length, ...elst.flatMap(([d, m]) => [d, m, 0x10000]))))]
    : [];
  return box(
    "moov",
    box("mvhd", u32(0, 0, 0, 1000, 0)),
    box("trak", tkhd, ...edts, box("mdia", mdhd, hdlr)),
  );
}

/** One fragment: tfdt and a trun v1 with per-sample duration and composition offset. */
function fragment(base: number, samples: [duration: number, cto: number][]): Uint8Array {
  const tfhd = box("tfhd", u32(0, 1));
  const tfdt = box("tfdt", u32(0, base));
  const trun = box("trun", u32((1 << 24) | 0x900, samples.length, ...samples.flat()));
  return box("moof", box("traf", tfhd, tfdt, trun));
}

describe("fragmented MP4 start time", () => {
  // 24 fps at timescale 12288: 512 ticks per frame. I P B B in decode order.
  const frames: [number, number][] = [
    [512, 0],
    [512, 1024],
    [512, -512],
    [512, -512],
  ];

  it("reads a CMAF fragment with negative composition offsets as starting at 0", () => {
    const [video] = fragmentStarts(init("vide", 12288), fragment(0, frames));
    expect(video?.firstPresentationSec).toBe(0);
    expect(video?.durationSec).toBeCloseTo(4 * (512 / 12288));
  });

  it("sees the B-frame delay of positive offsets with an empty edit (the 0.083 s gap)", () => {
    const delayed: [number, number][] = [
      [512, 1024],
      [512, 2048],
      [512, 512],
      [512, 512],
    ];
    const [video] = fragmentStarts(
      init("vide", 12288, [
        [83, -1],
        [0, 1024],
      ]),
      fragment(0, delayed),
    );
    expect(video?.firstPresentationSec).toBeCloseTo(0.083, 3);
  });

  it("applies an edit list's media time", () => {
    const [audio] = fragmentStarts(init("soun", 48000, [[0, 1024]]), fragment(0, [[1024, 0]]));
    expect(audio?.firstPresentationSec).toBe(0);
  });
});
