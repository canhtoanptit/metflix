import { normalizeSearchText } from "../ports/search-index.ts";
import type { NamedCreditRecord, TitleRecord } from "../repositories/records.ts";

/**
 * Content features of a title as a sparse vector, L2-normalised. Keys are namespaced:
 * `g:` genre, `m:` mood, `p:` person, `t:` type, `e:` era (decade), `o:` original.
 *
 * Weights encode what makes two titles "alike" for a viewer: genre dominates, mood and the
 * people behind a title refine it, type and era nudge. They are deliberately few and
 * readable so a recommendation can be explained ("Because you watched X": shared genre,
 * director...). See docs/RECOMMENDATIONS.md.
 */
export type FeatureVector = ReadonlyMap<string, number>;

const GENRE_WEIGHTS = [1.0, 0.8, 0.6];
const GENRE_WEIGHT_REST = 0.5;
const MOOD_WEIGHT = 0.5;
const DIRECTOR_WEIGHT = 0.6;
const CREATOR_WEIGHT = 0.6;
const WRITER_WEIGHT = 0.3;
const LEAD_CAST_WEIGHT = 0.4;
const CAST_WEIGHT = 0.2;
const LEAD_CAST_COUNT = 3;
const TYPE_WEIGHT = 0.3;
const ERA_WEIGHT = 0.15;
const ORIGINAL_WEIGHT = 0.1;

export function titleFeatures(
  title: TitleRecord,
  credits: readonly NamedCreditRecord[],
): FeatureVector {
  const raw = new Map<string, number>();
  const add = (key: string, weight: number) => raw.set(key, Math.max(raw.get(key) ?? 0, weight));

  title.genreIds.forEach((genreId, index) => {
    add(`g:${genreId}`, GENRE_WEIGHTS[index] ?? GENRE_WEIGHT_REST);
  });
  for (const mood of title.moods) add(`m:${normalizeSearchText(mood)}`, MOOD_WEIGHT);
  for (const credit of credits) {
    const weight =
      credit.role === "director"
        ? DIRECTOR_WEIGHT
        : credit.role === "creator"
          ? CREATOR_WEIGHT
          : credit.role === "writer"
            ? WRITER_WEIGHT
            : credit.position < LEAD_CAST_COUNT
              ? LEAD_CAST_WEIGHT
              : CAST_WEIGHT;
    add(`p:${credit.personId}`, weight);
  }
  add(`t:${title.type}`, TYPE_WEIGHT);
  add(`e:${Math.floor(title.releaseYear / 10) * 10}`, ERA_WEIGHT);
  if (title.isOriginal) add("o:original", ORIGINAL_WEIGHT);
  return normalize(raw);
}

export function normalize(vector: ReadonlyMap<string, number>): Map<string, number> {
  let norm = 0;
  for (const value of vector.values()) norm += value * value;
  norm = Math.sqrt(norm);
  const out = new Map<string, number>();
  if (norm === 0) return out;
  for (const [key, value] of vector) out.set(key, value / norm);
  return out;
}

export function dot(a: FeatureVector, b: FeatureVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [key, value] of small) {
    const other = large.get(key);
    if (other !== undefined) sum += value * other;
  }
  return sum;
}

export function addScaled(target: Map<string, number>, vector: FeatureVector, weight: number) {
  for (const [key, value] of vector) target.set(key, (target.get(key) ?? 0) + value * weight);
}
