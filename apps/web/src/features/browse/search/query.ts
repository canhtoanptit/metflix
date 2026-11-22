import { SEARCH_QUERY_MAX_LENGTH } from "@webflix/contracts";

/**
 * The search field's text rules. The server searches the first `SEARCH_QUERY_MAX_LENGTH`
 * characters (code points) of a query; the field never holds more, so what is typed is what is
 * searched, and nothing someone types or pastes can turn into an error.
 *
 * Cuts fall between whole characters as people see them (grapheme clusters: an emoji family, a
 * flag, a letter with its accent), never inside one, and never past the server's limit.
 */

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Length in code points (the unit the server counts in). */
export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/** `text` cut to at most `max` code points, between graphemes. */
export function capSearchText(text: string, max: number = SEARCH_QUERY_MAX_LENGTH): string {
  if (max <= 0) return "";
  if (codePointLength(text) <= max) return text;
  if (!segmenter) return Array.from(text).slice(0, max).join("");
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = codePointLength(segment);
    if (used + size > max) break;
    out += segment;
    used += size;
  }
  return out;
}

/** Pasted text as one line: line breaks and tabs become spaces, runs of spaces collapse. */
export function cleanPastedText(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Insert `text` over the selection `[start, end)` of `value` (UTF-16 offsets, as the input
 * reports them), keeping the result within the limit by shortening what is inserted. Returns
 * the new value and where the caret goes (after the inserted text).
 */
export function insertWithinLimit(
  value: string,
  text: string,
  start: number,
  end: number,
  max: number = SEARCH_QUERY_MAX_LENGTH,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const room = Math.max(0, max - codePointLength(before) - codePointLength(after));
  const inserted = capSearchText(text, room);
  return { value: before + inserted + after, caret: before.length + inserted.length };
}

/** A query from anywhere (the URL, a shared link) as it will be searched. */
export function searchQueryOf(raw: string | undefined | null): string {
  return capSearchText((raw ?? "").trim()).trim();
}
