import type { PlayTarget } from "@webflix/contracts";

/**
 * Router link props for the watch page (owned by the member + watch engineer):
 * `/watch/$titleId?episode=&t=`. Without an episode the server picks the resume point, which is
 * what every generic "Play" wants; an explicit episode plays that episode (from its own resume
 * point unless `t` is given).
 */
export function watchLink(
  titleId: string,
  options: { episodeId?: string | null; t?: number } = {},
) {
  const search: { episode?: string; t?: number } = {};
  if (options.episodeId) search.episode = options.episodeId;
  if (options.t !== undefined) search.t = Math.max(0, Math.round(options.t));
  return { to: "/watch/$titleId" as const, params: { titleId }, search };
}

/** Label of the primary play action for a play target ("Resume" when there is progress). */
export function playLabel(target: PlayTarget | null | undefined): "Play" | "Resume" {
  return target?.action === "resume" ? "Resume" : "Play";
}
