import { describe, expect, it } from "vitest";
import {
  clipCues,
  decodeSubtitleBytes,
  languageLabel,
  parseCues,
  toWebVtt,
} from "../src/video/subtitles.ts";

const SRT = `1
00:01:47,250 --> 00:01:50,500
<font color="#ffffff">This blade has a dark past.</font>

2
00:01:51,800 --> 00:01:55,800
It has shed much innocent blood.

3
00:02:30,000 -> 00:02:32,000
Arrows written short still count.
`;

describe("subtitles", () => {
  it("parses SRT, strips SRT-only styling and tolerates short arrows", () => {
    const cues = parseCues(SRT);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({
      startSec: 107.25,
      endSec: 110.5,
      text: "This blade has a dark past.",
    });
    expect(cues[2]?.startSec).toBe(150);
  });

  it("parses WebVTT with cue settings and skips NOTE blocks", () => {
    const vtt = "WEBVTT\n\nNOTE hello\n\n00:00:01.000 --> 00:00:02.500 line:90%\n<i>Hi</i> there\n";
    expect(parseCues(vtt)).toEqual([{ startSec: 1, endSec: 2.5, text: "<i>Hi</i> there" }]);
  });

  it("clips cues to an asset window and re-times them from zero", () => {
    const cues = clipCues(parseCues(SRT), 108, 5);
    expect(cues).toEqual([
      { startSec: 0, endSec: 2.5, text: "This blade has a dark past." },
      { startSec: 3.8, endSec: 5, text: "It has shed much innocent blood." },
    ]);
  });

  it("serialises valid WebVTT with escaped text", () => {
    const vtt = toWebVtt([{ startSec: 3661.5, endSec: 3662, text: "Tom & Jerry <3 <i>ok</i>" }]);
    expect(vtt).toBe(
      "WEBVTT\n\n1\n01:01:01.500 --> 01:01:02.000\nTom &amp; Jerry &lt;3 <i>ok</i>\n",
    );
  });

  it("decodes BOMs, UTF-8 and legacy code pages by language", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(decodeSubtitleBytes(utf16, "nb")).toBe("Hi");
    expect(decodeSubtitleBytes(new TextEncoder().encode("Ça va"), "fr")).toBe("Ça va");
    // "è" in windows-1252 (Italian files from the Sintel project are not UTF-8).
    expect(decodeSubtitleBytes(new Uint8Array([0x63, 0x27, 0xe8]), "it")).toBe("c'è");
    // "Да" in windows-1251.
    expect(decodeSubtitleBytes(new Uint8Array([0xc4, 0xe0]), "ru")).toBe("Да");
  });

  it("labels languages in their own language", () => {
    expect(languageLabel("de")).toBe("Deutsch");
    expect(languageLabel("pt-BR")).toMatch(/^Português/);
  });
});
