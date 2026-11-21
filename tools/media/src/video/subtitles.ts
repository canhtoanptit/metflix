/**
 * Subtitle conversion: SRT or WebVTT in (any of the encodings the open films' volunteer
 * translations ship in), clean WebVTT out, shifted and clipped to an asset's window so a
 * side-car track lines up with the packaged clip's own timeline (which starts at 0).
 */
export interface Cue {
  startSec: number;
  endSec: number;
  text: string;
}

/** Legacy single-byte/multi-byte encodings to try per language when the file is not UTF-8. */
const LEGACY_ENCODINGS: Record<string, string> = {
  ru: "windows-1251",
  uk: "windows-1251",
  bg: "windows-1251",
  sr: "windows-1251",
  el: "windows-1253",
  he: "windows-1255",
  fa: "windows-1256",
  ar: "windows-1256",
  tr: "windows-1254",
  pl: "windows-1250",
  cs: "windows-1250",
  hu: "windows-1250",
  hr: "windows-1250",
  ja: "shift_jis",
  zh: "gbk",
  "zh-Hant": "big5",
  ko: "euc-kr",
};

/** Decode subtitle bytes: BOMs first, then strict UTF-8, then the language's legacy code page. */
export function decodeSubtitleBytes(bytes: Uint8Array, language: string): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    const base = language.split("-")[0] ?? language;
    const encoding = LEGACY_ENCODINGS[language] ?? LEGACY_ENCODINGS[base] ?? "windows-1252";
    return new TextDecoder(encoding).decode(bytes);
  }
}

const TIMING = /\d[,.]\d+\s*-{1,2}>\s*\d/;
const TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function parseTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [, hours = "0", minutes = "0", seconds = "0", fraction = "0"] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(fraction.padEnd(3, "0")) / 1000
  );
}

/** Parse SRT or WebVTT cue blocks (cue settings and NOTE/STYLE blocks are dropped). */
export function parseCues(source: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = source.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    // Some volunteer files write "->" instead of "-->".
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex === -1) continue;
    const [startRaw = "", endRaw = ""] = (lines[timingIndex] ?? "").split(/-{1,2}>/);
    const startSec = parseTimestamp(startRaw);
    const endSec = parseTimestamp(endRaw);
    if (startSec === null || endSec === null || endSec <= startSec) continue;
    const text = lines
      .slice(timingIndex + 1)
      .map((line) => line.trim())
      .join("\n")
      // SRT styling that WebVTT does not understand.
      .replace(/<\/?font[^>]*>/gi, "")
      .replace(/\{\\[^}]*\}/g, "")
      .trim();
    if (text) cues.push({ startSec, endSec, text });
  }
  return cues.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Keep the cues that overlap `[startSec, startSec + durationSec)`, re-timed so the window
 * starts at 0 and clamped to it.
 */
export function clipCues(cues: readonly Cue[], startSec: number, durationSec: number): Cue[] {
  const endSec = startSec + durationSec;
  return cues
    .filter((cue) => cue.endSec > startSec && cue.startSec < endSec)
    .map((cue) => ({
      startSec: Math.round(Math.max(0, cue.startSec - startSec) * 1000) / 1000,
      endSec: Math.round(Math.min(durationSec, cue.endSec - startSec) * 1000) / 1000,
      text: cue.text,
    }))
    .filter((cue) => cue.endSec - cue.startSec >= 0.2);
}

function formatTimestamp(totalSec: number): string {
  const ms = Math.round(totalSec * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/** Serialize to WebVTT. Text is escaped except for the inline tags WebVTT allows. */
export function toWebVtt(cues: readonly Cue[]): string {
  const body = cues
    .map((cue, index) => {
      const text = cue.text
        .replace(/&(?!amp;|lt;|gt;|nbsp;|lrm;|rlm;)/g, "&amp;")
        .replace(/<(?!\/?(?:i|b|u|c|v|lang|ruby|rt)\b)/g, "&lt;");
      return `${index + 1}\n${formatTimestamp(cue.startSec)} --> ${formatTimestamp(cue.endSec)}\n${text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}${body ? "\n" : ""}`;
}

/** Human label for a subtitle language, in that language (as streaming menus show them). */
export function languageLabel(language: string): string {
  try {
    const name = new Intl.DisplayNames([language], { type: "language" }).of(language);
    if (!name) return language;
    return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
  } catch {
    return language;
  }
}
