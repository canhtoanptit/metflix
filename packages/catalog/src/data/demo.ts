/**
 * The demo account (blueprint §8). Histories are layered so a first visit fills every row
 * type: Continue Watching (in-progress movies and mid-season episodes), Watch It Again
 * (finished titles), Because You Watched (recent completions), My List and ratings. The kids
 * profile only touches titles rated 7+ or below.
 */
import { DEMO_ACCOUNT_EMAIL, DEMO_ACCOUNT_PASSWORD } from "@webflix/contracts";
import { episodeId } from "./assemble.ts";

type Rating = "dislike" | "like" | "love";
interface Viewing {
  titleId: string;
  episodeId: string | null;
  daysAgo: number;
  progress: number;
  completed: boolean;
}

const movie = (titleId: string, daysAgo: number, progress = 1): Viewing => ({
  titleId,
  episodeId: null,
  daysAgo,
  progress,
  completed: progress >= 0.95,
});

/**
 * Every episode from S1E1 up to `season`/`episode` watched in full (one a day, going back
 * from `daysAgo`), then that episode at `progress`.
 */
function bingeTo(
  titleId: string,
  seasons: readonly number[],
  season: number,
  episode: number,
  daysAgo: number,
  progress: number,
): Viewing[] {
  const out: Viewing[] = [];
  let age = daysAgo;
  for (let s = season; s >= 1; s -= 1) {
    const last = s === season ? episode : (seasons[s - 1] ?? 1);
    for (let e = last; e >= 1; e -= 1) {
      const current = s === season && e === episode;
      out.push({
        titleId,
        episodeId: episodeId(titleId, s, e),
        daysAgo: Math.round(age * 10) / 10,
        progress: current ? progress : 1,
        completed: current ? progress >= 0.95 : true,
      });
      age += current ? 0.6 : 0.8;
    }
  }
  return out;
}

const rate = (value: Rating, ...titleIds: string[]) =>
  titleIds.map((titleId) => ({ titleId, value }));

export const demoAccountInput = {
  email: DEMO_ACCOUNT_EMAIL,
  password: DEMO_ACCOUNT_PASSWORD,
  planId: "premium",
  profiles: [
    {
      id: "pr-demo-alex",
      name: "Alex",
      avatarId: "a-sunny",
      isKids: false,
      maturityCeiling: "18+",
      pin: null,
      myList: [
        "t-the-ember-crown",
        "t-lagrange",
        "t-gilt",
        "t-tidemark",
        "t-every-other-summer",
        "t-the-assembly",
        "t-borrowed-faces",
        "t-meridian",
        "t-closing-time",
        "t-cosmos-laundromat",
      ],
      ratings: [
        ...rate("love", "t-saltmarsh", "t-dead-drop", "t-sintel", "t-kintsugi"),
        ...rate(
          "like",
          "t-the-fenwick-accounts",
          "t-plus-ones",
          "t-tears-of-steel",
          "t-the-hollow-bell",
          "t-breakline",
          "t-pale-hours",
        ),
        ...rate("dislike", "t-grand-prize", "t-tempest-run"),
      ],
      viewing: [
        ...bingeTo("t-saltmarsh", [6, 6], 2, 3, 0.6, 0.42),
        ...bingeTo("t-dead-drop", [8], 1, 5, 0.3, 0.66),
        ...bingeTo("t-the-ember-crown", [8, 6], 1, 2, 3, 0.2),
        ...bingeTo("t-plus-ones", [6, 6], 1, 4, 6, 0.8),
        movie("t-ninety-seconds", 2, 0.55),
        movie("t-sintel", 4, 0.35),
        movie("t-tears-of-steel", 9),
        movie("t-kintsugi", 12),
        movie("t-breakline", 15),
        ...bingeTo("t-the-fenwick-accounts", [6, 6], 2, 6, 20, 1),
        movie("t-pale-hours", 25),
        ...bingeTo("t-the-hollow-bell", [6, 6], 1, 6, 30, 1),
        movie("t-the-understudy", 40),
      ],
    },
    {
      id: "pr-demo-jordan",
      name: "Jordan",
      avatarId: "a-midnight-cat",
      isKids: false,
      maturityCeiling: "18+",
      // Demo PIN: shows the locked-profile flow on the "Who's watching?" gate.
      pin: "2468",
      settings: { autoplayNextEpisode: true, autoplayPreviews: true },
      myList: [
        "t-hearth",
        "t-coldharbour",
        "t-the-varga-files",
        "t-frostline",
        "t-hadal",
        "t-sprite-fright",
      ],
      ratings: [
        ...rate("love", "t-clean-hands", "t-uplink", "t-coldharbour"),
        ...rate("like", "t-idle", "t-loopback", "t-signal-loss", "t-elephants-dream"),
        ...rate("dislike", "t-out-of-office"),
      ],
      viewing: [
        ...bingeTo("t-coldharbour", [8], 1, 4, 1.2, 0.3),
        ...bingeTo("t-the-appraisers", [8], 1, 2, 2.5, 0.75),
        movie("t-loopback", 3, 0.3),
        movie("t-clean-hands", 8),
        movie("t-idle", 11),
        ...bingeTo("t-uplink", [8], 1, 8, 16, 1),
        movie("t-signal-loss", 22),
        movie("t-elephants-dream", 35),
      ],
    },
    {
      id: "pr-demo-mia",
      name: "Mia",
      avatarId: "a-bubblegum",
      isKids: false,
      maturityCeiling: "13+",
      pin: null,
      settings: { subtitleLanguage: "es", autoplayPreviews: false },
      myList: [
        "t-postcards-from-lisbon",
        "t-the-final-crumb",
        "t-second-chair",
        "t-wing-it",
        "t-shortbread",
      ],
      ratings: [
        ...rate("love", "t-spring", "t-coffee-run", "t-every-other-summer"),
        ...rate("like", "t-the-final-crumb", "t-slow-dance"),
      ],
      viewing: [
        ...bingeTo("t-shortbread", [8], 1, 2, 0.8, 0.5),
        movie("t-sprite-fright", 1.5, 0.6),
        ...bingeTo("t-the-final-crumb", [8], 1, 3, 4, 0.25),
        movie("t-spring", 6),
        movie("t-coffee-run", 6.2),
        movie("t-every-other-summer", 13),
        movie("t-slow-dance", 27),
      ],
    },
    {
      id: "pr-demo-kids",
      name: "Kids",
      avatarId: "a-bamboo",
      isKids: true,
      maturityCeiling: "7+",
      pin: null,
      myList: [
        "t-the-burrow-brigade",
        "t-ollies-orchard",
        "t-twelve-paws",
        "t-wing-it",
        "t-spring",
      ],
      ratings: [
        ...rate("love", "t-big-buck-bunny", "t-pip-and-the-pocket-dragons", "t-caminandes"),
        ...rate("like", "t-max-and-the-moon-balloon", "t-galaxy-garage"),
      ],
      viewing: [
        ...bingeTo("t-pip-and-the-pocket-dragons", [8, 8], 1, 3, 0.4, 0.55),
        movie("t-big-buck-bunny", 1, 0.5),
        ...bingeTo("t-galaxy-garage", [10], 1, 2, 2, 0.35),
        ...bingeTo("t-caminandes", [3], 1, 3, 5, 1),
        movie("t-max-and-the-moon-balloon", 9),
        movie("t-the-lighthouse-mouse", 18),
      ],
    },
  ],
};
