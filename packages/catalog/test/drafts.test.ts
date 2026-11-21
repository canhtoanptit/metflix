import { describe, expect, it } from "vitest";
import { MOODS, type TitleDraft } from "../src/data/draft.ts";
import { PEOPLE } from "../src/data/people.ts";
import { batchA } from "../src/data/titles/batch-a.ts";
import { batchB } from "../src/data/titles/batch-b.ts";
import { batchC } from "../src/data/titles/batch-c.ts";
import { batchD } from "../src/data/titles/batch-d.ts";

/**
 * Editorial lint for hand-written drafts: catches the mistakes the schema cannot (filler copy,
 * clichés, implausible runtimes, the same actor twice in one cast).
 */
const BANNED = [
  /nothing is as it seems/i,
  /in a world where/i,
  /must confront/i,
  /lorem/i,
  /\bTBD\b/,
  /\bTODO\b/,
  /little does (s?he|they) know/i,
  /one fateful/i,
  /embark(s)? on a journey/i,
  /\bEpisode \d+\b/,
];

const people = new Set<string>(PEOPLE.map(([id]) => id));
const moods = new Set<string>(MOODS);

function problems(draft: TitleDraft): string[] {
  const out: string[] = [];
  const say = (message: string) => out.push(`${draft.id}: ${message}`);
  const text = (label: string, value: string, min: number, max: number) => {
    if (value.length < min || value.length > max) {
      say(`${label} is ${value.length} chars (want ${min}-${max}): ${value.slice(0, 60)}…`);
    }
    for (const pattern of BANNED) if (pattern.test(value)) say(`${label} uses ${pattern}`);
    if (/\s{2,}/.test(value) || value !== value.trim()) say(`${label} has stray whitespace`);
  };
  if (!/^t-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.id)) say("id must be t-<kebab-case>");
  text("synopsis", draft.synopsis, 110, 420);
  if (draft.tagline !== null) text("tagline", draft.tagline, 8, 70);
  if (draft.moods.length < 3 || draft.moods.length > 5) say("needs 3-5 moods");
  for (const mood of draft.moods) if (!moods.has(mood)) say(`unknown mood ${mood}`);
  if (draft.genres.length < 1 || draft.genres.length > 3) say("needs 1-3 genres");
  if (draft.cast.length < 1) say("needs a cast (narrators and hosts count)");
  const credited = [
    ...draft.cast.map(([id]) => id),
    ...(draft.directors ?? []),
    ...(draft.creators ?? []),
    ...(draft.writers ?? []),
  ];
  for (const id of credited) {
    if (!people.has(id) && !id.startsWith("p-open-")) say(`unknown person ${id}`);
  }
  const castIds = draft.cast.map(([id]) => id);
  if (new Set(castIds).size !== castIds.length) say("same person twice in the cast");
  if ((draft.directors ?? []).length === 0) say("needs at least one director");
  if (draft.maturity === "ALL" && draft.advisories.some((a) => !a.startsWith("mild"))) {
    say("ALL-rated titles only carry mild advisories");
  }
  if (draft.popularity < 0 || draft.popularity > 100) say("popularity out of range");
  if (draft.type === "movie") {
    if (draft.minutes < 3 || draft.minutes > 200) say(`implausible runtime ${draft.minutes}`);
    return out;
  }
  if ((draft.creators ?? []).length === 0) say("series need a creator");
  const names = new Set<string>();
  draft.seasons.forEach((season, s) => {
    if (season.episodes.length < 3) say(`season ${s + 1} has fewer than 3 episodes`);
    if (s > 0 && season.year < (draft.seasons[s - 1]?.year ?? 0)) say("season years go back");
    for (const [name, minutes, synopsis] of season.episodes) {
      if (names.has(name)) say(`duplicate episode name ${name}`);
      names.add(name);
      text(`episode "${name}"`, synopsis, 60, 280);
      if (minutes < 5 || minutes > 95) say(`episode "${name}" runtime ${minutes}`);
    }
  });
  if (draft.seasons[0]?.year !== draft.year) say("year must equal the first season's year");
  return out;
}

describe.each([
  ["A", batchA],
  ["B", batchB],
  ["C", batchC],
  ["D", batchD],
])("draft batch %s", (_label, batch) => {
  it("passes the editorial lint", () => {
    expect(batch.flatMap(problems)).toEqual([]);
  });
});

describe("all drafts", () => {
  it("have unique ids and names", () => {
    const all = [...batchA, ...batchB, ...batchC, ...batchD];
    const ids = all.map((draft) => draft.id);
    const names = all.map((draft) => draft.name.toLowerCase());
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });
});
