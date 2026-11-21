import {
  DEFAULT_PROFILE_SETTINGS,
  MAX_PROFILES_PER_ACCOUNT,
  type MaturityLevel,
  type TitleCard,
} from "@webflix/contracts";
import type { Environment, TestAccount, Viewer } from "../env.ts";
import { check, equal, problem, rejects, succeeds } from "../expect.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, browseAll, CSRF, cardsOfPage, maturityRank, unique } from "./util.ts";

/** Shared by the kids and PIN checks; a keeper profile means neither ever deletes the last one. */
function profilesAccount(env: Environment): Promise<TestAccount> {
  return env.once("account:profiles-with-keeper", async () => {
    const account = await env.signup("profiles");
    await env.createProfile(account.agent, { name: "Keeper" });
    return account;
  });
}

/** Every card a profile can reach on browse, genre pages and search must sit under its ceiling. */
async function assertCeiling(
  ctx: CheckContext,
  viewer: Viewer,
  ceiling: MaturityLevel,
  restricted: TitleCard,
): Promise<void> {
  const agent = viewer.agent;
  const over = (card: TitleCard) => maturityRank(card.maturity) > maturityRank(ceiling);
  for (const view of ["home", "series", "movies", "new-popular"] as const) {
    const { pages } = await browseAll(agent, view, 4);
    const leaked = pages.flatMap(cardsOfPage).filter(over);
    check(leaked.length === 0, `browse ${view} shows titles above ${ceiling}`, {
      observed: leaked
        .slice(0, 5)
        .map((card) => `${card.id} (${card.maturity})`)
        .join(", "),
    });
  }
  const genres = await succeeds(() => agent.api.listGenres(), "GET /genres");
  for (const genre of genres.items.slice(0, 4)) {
    const page = await succeeds(
      () => agent.api.getGenreBrowse({ params: { slug: genre.slug }, query: { limit: 100 } }),
      `genre ${genre.slug}`,
    );
    const leaked = page.items.filter(over);
    check(leaked.length === 0, `genre ${genre.slug} shows titles above ${ceiling}`, {
      observed: leaked.map((card) => `${card.id} (${card.maturity})`).join(", "),
    });
  }
  const search = await succeeds(
    () => agent.api.search({ query: { q: restricted.name, limit: 100 } }),
    `search "${restricted.name}"`,
  );
  check(
    !search.results.some((card) => card.id === restricted.id),
    `search finds ${restricted.id} (${restricted.maturity}) on a ${ceiling} profile`,
  );
  const searchLeaks = search.results.filter(over);
  check(searchLeaks.length === 0, `search shows titles above ${ceiling}`, {
    observed: searchLeaks.map((card) => `${card.id} (${card.maturity})`).join(", "),
  });
  const detail = await rejects(
    () => agent.api.getTitle({ params: { id: restricted.id } }),
    "maturity_restricted",
    `GET /titles/${restricted.id} (${restricted.maturity}) on a ${ceiling} profile`,
  );
  equal(detail.problem.maturity, restricted.maturity, "maturity_restricted.maturity");
  equal(
    detail.problem.profileMaturityCeiling,
    ceiling,
    "maturity_restricted.profileMaturityCeiling",
  );
  await rejects(
    () => agent.api.listSimilar({ params: { id: restricted.id } }),
    "maturity_restricted",
    "More like this",
  );
  if (restricted.type === "series") {
    await rejects(
      () => agent.api.listEpisodes({ params: { id: restricted.id, seasonNumber: 1 } }),
      "maturity_restricted",
      "episodes",
    );
  }
  await rejects(
    () => agent.api.createPlaybackSession({ body: { titleId: restricted.id } }),
    "maturity_restricted",
    "playback",
  );
  await rejects(
    () => agent.api.addToMyList({ params: { titleId: restricted.id } }),
    "maturity_restricted",
    "My List",
  );
  await rejects(
    () => agent.api.rateTitle({ params: { titleId: restricted.id }, body: { value: "love" } }),
    "maturity_restricted",
    "rating",
  );
  ctx.note(
    `${ceiling} profile: browse, genres, search, detail, similar, playback, My List and ratings filtered`,
  );
}

export const profileChecks: CheckDefinition[] = [
  {
    id: "profiles.crud",
    area: "profiles",
    title: "Create, edit and delete profiles; the last one cannot be deleted",
    async run(ctx: CheckContext) {
      const account = await ctx.env.signup("profiles-crud");
      const agent = account.agent;
      const empty = await succeeds(() => agent.api.listProfiles(), "GET /profiles");
      equal(empty.items.length, 0, "profiles of a new account");
      equal(empty.maxProfiles, MAX_PROFILES_PER_ACCOUNT, "maxProfiles");
      const avatars = await succeeds(() => agent.api.listAvatars(), "GET /avatars");
      const avatarIds = avatars.groups.flatMap((group) => group.avatars.map((avatar) => avatar.id));
      check(avatarIds.length >= 2, "the avatar picker needs at least two avatars", {
        observed: String(avatarIds.length),
      });
      const [firstAvatar = "", secondAvatar = ""] = avatarIds;
      const alpha = await succeeds(
        () => agent.api.createProfile({ body: { name: "Alpha", avatarId: firstAvatar } }),
        "POST /profiles",
      );
      equal(alpha.isKids, false, "isKids default");
      equal(alpha.maturityCeiling, "18+", "maturityCeiling default");
      equal(alpha.isLocked, false, "isLocked default");
      equal(alpha.settings, DEFAULT_PROFILE_SETTINGS, "settings default");
      equal(alpha.avatar.id, firstAvatar, "avatar");
      await rejects(
        () =>
          agent.api.createProfile({ body: { name: "Ghost", avatarId: "a-smoke-no-such-avatar" } }),
        "not_found",
        "unknown avatar",
      );
      problem(
        await agent.fetch(`${API}/profiles`, {
          method: "POST",
          headers: CSRF,
          body: { name: "x".repeat(31), avatarId: firstAvatar },
        }),
        "validation_failed",
        "31-character name",
      );
      const edited = await succeeds(
        () =>
          agent.api.updateProfile({
            params: { id: alpha.id },
            body: {
              name: "Alpha Prime",
              avatarId: secondAvatar,
              settings: { autoplayPreviews: false, subtitleLanguage: "en" },
            },
          }),
        "PATCH /profiles/:id",
      );
      equal(edited.name, "Alpha Prime", "edited name");
      equal(edited.avatar.id, secondAvatar, "edited avatar");
      equal(
        edited.settings,
        { autoplayNextEpisode: true, autoplayPreviews: false, subtitleLanguage: "en" },
        "partially edited settings",
      );
      const lowered = await succeeds(
        () =>
          agent.api.updateProfile({ params: { id: alpha.id }, body: { maturityCeiling: "13+" } }),
        "lower the maturity ceiling (no password needed)",
      );
      equal(lowered.maturityCeiling, "13+", "lowered ceiling");
      await rejects(
        () =>
          agent.api.updateProfile({ params: { id: alpha.id }, body: { maturityCeiling: "18+" } }),
        "password_required",
        "raise the ceiling without the account password",
      );
      const raised = await succeeds(
        () =>
          agent.api.updateProfile({
            params: { id: alpha.id },
            body: { maturityCeiling: "18+", currentPassword: account.password },
          }),
        "raise the ceiling with the account password",
      );
      equal(raised.maturityCeiling, "18+", "raised ceiling");
      const beta = await succeeds(
        () => agent.api.createProfile({ body: { name: "Beta", avatarId: firstAvatar } }),
        "second profile",
      );
      const listed = await succeeds(() => agent.api.listProfiles(), "GET /profiles");
      equal(
        listed.items
          .map((profile) => profile.id)
          .sort()
          .join(","),
        [alpha.id, beta.id].sort().join(","),
        "listed profiles",
      );
      await succeeds(
        () => agent.api.deleteProfile({ params: { id: beta.id } }),
        "DELETE /profiles/:id",
      );
      const after = await succeeds(() => agent.api.getSession(), "GET /session");
      check(
        after.authenticated && after.profiles.every((profile) => profile.id !== beta.id),
        "deleted profile still listed",
      );
      await rejects(
        () => agent.api.deleteProfile({ params: { id: beta.id } }),
        "not_found",
        "deleting it again",
      );
      await rejects(
        () => agent.api.deleteProfile({ params: { id: alpha.id } }),
        "profile_last_remaining",
        "deleting the last profile",
      );
    },
  },
  {
    id: "profiles.five-profile-cap",
    area: "profiles",
    title: "An account holds at most five profiles",
    async run(ctx: CheckContext) {
      const account = await ctx.env.signup("profiles-cap");
      for (let index = 1; index <= MAX_PROFILES_PER_ACCOUNT; index += 1) {
        await ctx.env.createProfile(account.agent, { name: `Cap ${index}` });
      }
      const avatarId = await ctx.env.avatarId(account.agent);
      const sixth = await rejects(
        () => account.agent.api.createProfile({ body: { name: "Cap 6", avatarId } }),
        "profile_limit_reached",
        "sixth profile",
      );
      check(sixth.status === 409, "profile_limit_reached status", {
        observed: String(sixth.status),
      });
      const listed = await succeeds(() => account.agent.api.listProfiles(), "GET /profiles");
      equal(listed.items.length, MAX_PROFILES_PER_ACCOUNT, "profiles after the cap");
    },
  },
  {
    id: "profiles.kids",
    area: "profiles",
    title: "Kids profiles are capped at 7+; loosening parental controls needs the password",
    async run(ctx: CheckContext) {
      const account = await profilesAccount(ctx.env);
      const kids = await ctx.env.createProfile(account.agent, {
        name: unique("Kid").slice(0, 20),
        isKids: true,
      });
      equal(kids.isKids, true, "isKids");
      equal(kids.maturityCeiling, "7+", "kids default ceiling");
      const capped = await ctx.env.createProfile(account.agent, {
        name: unique("Kid18").slice(0, 20),
        isKids: true,
        maturityCeiling: "18+",
      });
      equal(capped.maturityCeiling, "7+", "kids profile asking for 18+");
      // While a profile is a kids profile, a higher ceiling is clamped to 7+, not refused.
      const clamped = await succeeds(
        () =>
          account.agent.api.updateProfile({
            params: { id: kids.id },
            body: { maturityCeiling: "13+" },
          }),
        "asking a kids profile for 13+",
      );
      equal(clamped.maturityCeiling, "7+", "a kids profile asking for 13+ stays at 7+");
      await rejects(
        () =>
          account.agent.api.updateProfile({
            params: { id: kids.id },
            body: {
              isKids: false,
              maturityCeiling: "16+",
              currentPassword: `${account.password}-wrong`,
            },
          }),
        "current_password_invalid",
        "turning off kids with a wrong password",
      );
      const grown = await succeeds(
        () =>
          account.agent.api.updateProfile({
            params: { id: capped.id },
            body: { isKids: false, maturityCeiling: "16+", currentPassword: account.password },
          }),
        "turning off kids with the password",
      );
      equal(grown.isKids, false, "isKids after turning it off");
      equal(grown.maturityCeiling, "16+", "ceiling after turning off kids");
      await succeeds(
        () => account.agent.api.deleteProfile({ params: { id: capped.id } }),
        "cleanup",
      );
      await succeeds(() => account.agent.api.deleteProfile({ params: { id: kids.id } }), "cleanup");
    },
  },
  {
    id: "profiles.kids-off-needs-password",
    area: "profiles",
    title: 'Turning off "kids" requires the account password (documented parental control)',
    async run(ctx: CheckContext) {
      const account = await profilesAccount(ctx.env);
      const kids = await ctx.env.createProfile(account.agent, {
        name: unique("KidOff").slice(0, 20),
        isKids: true,
      });
      try {
        // BACKEND.md §3 and DECISIONS D11: "raising a ceiling (including turning off kids)
        // requires currentPassword", even when the ceiling itself stays at 7+.
        await rejects(
          () =>
            account.agent.api.updateProfile({ params: { id: kids.id }, body: { isKids: false } }),
          "password_required",
          "turning off kids without the password",
        );
      } finally {
        await account.agent.api.deleteProfile({ params: { id: kids.id } }).catch(() => undefined);
      }
    },
  },
  {
    id: "profiles.maturity-filtering",
    area: "profiles",
    title: "Kids (7+) and 13+ ceilings filter browse, search, detail and playback server-side",
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const { cards } = await ctx.env.catalog();
      const highest = [...cards].sort(
        (a, b) => maturityRank(b.maturity) - maturityRank(a.maturity),
      )[0];
      if (!highest || maturityRank(highest.maturity) <= maturityRank("7+")) {
        ctx.skip("the catalog has no title above 7+, so ceilings cannot be observed");
      }
      const restrictedForTeen = cards.find(
        (card) => maturityRank(card.maturity) > maturityRank("13+"),
      );
      const visibleToTeen = cards.find((card) => card.maturity === "13+");
      const kids = await ctx.env.isolatedViewer("kids-filter", { isKids: true });
      equal(kids.profile.maturityCeiling, "7+", "kids ceiling");
      await assertCeiling(ctx, kids, "7+", highest);
      if (!restrictedForTeen) {
        ctx.note("no title above 13+: the 13+ ceiling was not exercised");
        return;
      }
      const teen = await ctx.env.isolatedViewer("teen-filter", { maturityCeiling: "13+" });
      await assertCeiling(ctx, teen, "13+", restrictedForTeen);
      if (visibleToTeen) {
        await succeeds(
          () => teen.agent.api.getTitle({ params: { id: visibleToTeen.id } }),
          `a 13+ title on a 13+ profile`,
        );
      }
    },
  },
  {
    id: "profiles.pin",
    area: "profiles",
    title: "PIN lock: setting needs the password; selection needs the right PIN",
    async run(ctx: CheckContext) {
      const account = await profilesAccount(ctx.env);
      const agent = await ctx.env.login(account, "pin");
      const locked = await ctx.env.createProfile(agent, { name: unique("Locked").slice(0, 20) });
      await rejects(
        () => agent.api.updateProfile({ params: { id: locked.id }, body: { pin: "2468" } }),
        "password_required",
        "setting a PIN without the password",
      );
      await rejects(
        () =>
          agent.api.updateProfile({
            params: { id: locked.id },
            body: { pin: "2468", currentPassword: "wrong-password" },
          }),
        "current_password_invalid",
        "setting a PIN with a wrong password",
      );
      problem(
        await agent.fetch(`${API}/profiles/${locked.id}`, {
          method: "PATCH",
          headers: CSRF,
          body: { pin: "24a8", currentPassword: account.password },
        }),
        "validation_failed",
        "a PIN that is not 4 digits",
      );
      const withPin = await succeeds(
        () =>
          agent.api.updateProfile({
            params: { id: locked.id },
            body: { pin: "2468", currentPassword: account.password },
          }),
        "setting a PIN with the password",
      );
      equal(withPin.isLocked, true, "isLocked");
      const raw = await agent.fetch(`${API}/profiles`);
      check(
        !raw.text().includes("2468") && !/"pin"\s*:/.test(raw.text()),
        "the PIN is returned by the API",
        {
          exchange: raw.exchange,
        },
      );
      await rejects(
        () => agent.api.selectProfile({ body: { profileId: locked.id } }),
        "profile_pin_required",
        "selecting without the PIN",
      );
      await rejects(
        () => agent.api.selectProfile({ body: { profileId: locked.id, pin: "1357" } }),
        "profile_pin_invalid",
        "selecting with a wrong PIN",
      );
      const selected = await succeeds(
        () => agent.api.selectProfile({ body: { profileId: locked.id, pin: "2468" } }),
        "selecting with the right PIN",
      );
      equal(selected.activeProfile?.id, locked.id, "active profile after the right PIN");
      await rejects(
        () => agent.api.updateProfile({ params: { id: locked.id }, body: { pin: null } }),
        "password_required",
        "clearing the PIN without the password",
      );
      const cleared = await succeeds(
        () =>
          agent.api.updateProfile({
            params: { id: locked.id },
            body: { pin: null, currentPassword: account.password },
          }),
        "clearing the PIN with the password",
      );
      equal(cleared.isLocked, false, "isLocked after clearing");
      await succeeds(
        () => agent.api.selectProfile({ body: { profileId: locked.id } }),
        "selecting without a PIN once cleared",
      );
      await succeeds(() => agent.api.clearProfile(), "leave the profile");
      await succeeds(() => agent.api.deleteProfile({ params: { id: locked.id } }), "cleanup");
    },
  },
];
