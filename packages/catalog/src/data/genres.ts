import type { GenreSeed } from "@webflix/contracts";

/** The sixteen browse genres. Order is the order genre rows are offered in. */
export const GENRES = [
  {
    slug: "drama",
    name: "Drama",
    description: "Character-driven stories about people under pressure.",
  },
  {
    slug: "comedy",
    name: "Comedy",
    description: "Sitcoms, cringe and big-hearted comedies of bad decisions.",
  },
  {
    slug: "thriller",
    name: "Thriller",
    description: "Ticking clocks, impossible choices and nobody to trust.",
  },
  { slug: "crime", name: "Crime", description: "Heists, cons, cops and the people they chase." },
  {
    slug: "mystery",
    name: "Mystery",
    description: "Whodunits, cold cases and secrets that will not stay buried.",
  },
  {
    slug: "sci-fi",
    name: "Sci-Fi",
    description: "Near futures, far planets and the questions technology cannot answer.",
  },
  {
    slug: "fantasy",
    name: "Fantasy",
    description: "Old magic, new myths and worlds just past the edge of the map.",
  },
  {
    slug: "horror",
    name: "Horror",
    description: "Slow dread, folk terror and things in the dark.",
  },
  {
    slug: "romance",
    name: "Romance",
    description: "Meet-cutes, second chances and love at the wrong time.",
  },
  {
    slug: "action-adventure",
    name: "Action & Adventure",
    description: "Rescues, races and missions with no margin for error.",
  },
  {
    slug: "documentary",
    name: "Documentary",
    description: "True stories from the deep ocean to the edge of the solar system.",
  },
  {
    slug: "animation",
    name: "Animation",
    description: "Hand-drawn, computer-animated and everything in between.",
  },
  {
    slug: "kids-family",
    name: "Kids & Family",
    description: "Stories the whole family can watch together.",
  },
  {
    slug: "historical",
    name: "Historical",
    description: "Period drama and true-to-life stories from centuries past.",
  },
  {
    slug: "reality",
    name: "Reality & Competition",
    description: "Bake-offs, build-offs, survival challenges and dating experiments.",
  },
  {
    slug: "short-films",
    name: "Short Films",
    description: "Complete stories in under half an hour, including the Blender open movies.",
  },
] as const;

export type GenreSlug = (typeof GENRES)[number]["slug"];

export const genreId = (slug: GenreSlug): string => `g-${slug}`;

export const genreSeeds: GenreSeed[] = GENRES.map((genre) => ({
  id: genreId(genre.slug),
  slug: genre.slug,
  name: genre.name,
  description: genre.description,
}));
