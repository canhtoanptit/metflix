/**
 * Mock implementations of the API routes, typed against the route table: each handler receives
 * the route's input and must return its exact output type.
 */
import {
  type AuthenticatedSession,
  type BrowseView,
  type CardViewerState,
  type ContinueWatchingItem,
  DEFAULT_MATURITY_CEILING,
  type EpisodeRef,
  type ErrorCode,
  KIDS_MATURITY_CEILING,
  MATURITY_LEVELS,
  type NotificationList,
  type PaymentMethod,
  type Progress,
  type RankedItem,
  type RouteInput,
  type RouteOutput,
  type Routes,
  type Row,
  type SessionState,
  SHOWCASE_MATURITY_CEILING,
  SHOWCASE_SIZE,
  type TitleBadge,
  type TitleCard,
} from "@webflix/contracts";
import {
  billingPaymentMethod,
  billingSessionFields,
  createBillingHandlers,
  requireEntitled,
  resetBillingForNewAccount,
} from "./billing.ts";
import {
  allGenres,
  avatarCatalog,
  type BadgeSurface,
  billboardFor,
  episodeId,
  episodesOf,
  genreBySlug,
  iso,
  PLANS,
  seedById,
  surfaceBadges,
  titleCard,
  titleDetail,
  titleId,
  titleImage,
  top10,
} from "./catalog.ts";
import { MOCK_TITLES } from "./data/catalog.ts";
import type { MockTitleSeed } from "./data/types.ts";
import {
  elevate,
  elevationOf,
  identityAccountFields,
  identityOf,
  mockElevated,
  mockTokenValid,
} from "./identity.ts";
import { type MockProfileRecord, type MockState, saveState, toProfile } from "./state.ts";

export class MockProblem extends Error {
  readonly code: ErrorCode;
  readonly extensions: Record<string, unknown>;
  constructor(code: ErrorCode, extensions: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.extensions = extensions;
  }
}

export type MockHandlers = {
  [K in keyof Routes]?: (
    input: RouteInput<Routes[K]>,
    state: MockState,
  ) => RouteOutput<Routes[K]> | Promise<RouteOutput<Routes[K]>>;
};

const PAGE = 20;

// --- Session helpers ---------------------------------------------------------------------------

function sessionOf(state: MockState): SessionState {
  if (!state.signedIn) return { authenticated: false };
  return authenticated(state);
}

function authenticated(state: MockState): AuthenticatedSession {
  const plan = PLANS.find((candidate) => candidate.id === state.planId) ?? PLANS[1];
  if (!plan) throw new MockProblem("internal_error");
  const active = state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;
  const billing = billingSessionFields(state);
  // No membership is exactly that, as the server says: no subscription, no plan.
  const member = billing.membership?.status !== "none";
  return {
    authenticated: true,
    account: {
      id: state.account.id,
      email: state.account.email,
      createdAt: state.account.createdAt,
      ...(state.account.isDemo ? { isDemo: true as const } : {}),
      ...identityAccountFields(state),
    },
    subscription: member
      ? {
          planId: state.planId,
          status: state.subscriptionStatus,
          startedAt: state.account.createdAt,
          currentPeriodEnd: iso(-12 * 86_400_000),
          canceledAt: state.subscriptionStatus === "active" ? null : iso(86_400_000),
        }
      : null,
    plan: member ? plan : null,
    profiles: state.profiles.map(toProfile),
    activeProfile: active ? toProfile(active) : null,
    ...billing,
  };
}

const SEEDED_CARD: PaymentMethod = { brand: "visa", last4: "4242", expMonth: 8, expYear: 2029 };

function paymentMethodOf(state: MockState): PaymentMethod | null {
  return billingPaymentMethod(state, SEEDED_CARD);
}

function requireAccount(state: MockState): void {
  if (!state.signedIn) throw new MockProblem("unauthenticated");
}

function requireProfile(state: MockState): MockProfileRecord {
  requireAccount(state);
  const profile = state.profiles.find((candidate) => candidate.id === state.activeProfileId);
  if (!profile) throw new MockProblem("profile_required");
  return profile;
}

// --- Privileges (the server's rules: who may manage the account and its profiles) -------------

type Maturity = MockProfileRecord["maturityCeiling"];

function rank(level: Maturity): number {
  return MATURITY_LEVELS.indexOf(level);
}

/** At the gate, on a kids profile, on a lowered ceiling, or without parental controls. */
function standingOf(
  profile: MockProfileRecord | undefined,
): "gate" | "kids" | "restricted" | "unrestricted" {
  if (!profile) return "gate";
  if (profile.isKids) return "kids";
  return rank(profile.maturityCeiling) < rank(DEFAULT_MATURITY_CEILING)
    ? "restricted"
    : "unrestricted";
}

function standingOfSession(state: MockState) {
  return standingOf(state.profiles.find((candidate) => candidate.id === state.activeProfileId));
}

/** Account management (`auth: "account-holder"`): an active profile without parental controls. */
function requireAccountHolder(state: MockState): void {
  requireAccount(state);
  const standing = standingOfSession(state);
  if (standing === "gate") throw new MockProblem("profile_required");
  if (standing !== "unrestricted") throw new MockProblem("unrestricted_profile_required");
}

function requireNotKids(state: MockState): void {
  if (standingOfSession(state) === "kids") throw new MockProblem("unrestricted_profile_required");
}

function requireNotDemo(state: MockState): void {
  if (state.account.isDemo) throw new MockProblem("demo_account_protected");
}

function parentalControlsInUse(state: MockState): boolean {
  return state.profiles.some(
    (profile) => profile.pin !== null || standingOf(profile) !== "unrestricted",
  );
}

function checkPassword(state: MockState, password: string | undefined): void {
  // Milestone 2: a fresh account-holder proof stands in for the password; an account created
  // through an issuer has no password, so none proves anything for it.
  if (password === undefined) {
    if (mockElevated(state)) return;
    throw new MockProblem("password_required");
  }
  if (!identityOf(state).hasPassword) throw new MockProblem("password_required");
  if (password !== state.account.password) throw new MockProblem("current_password_invalid");
}

/** A locked profile is its owner's: its PIN, or the account password instead. */
function checkUnlock(
  state: MockState,
  profile: MockProfileRecord,
  proof: { currentPin?: string | undefined; currentPassword?: string | undefined } | undefined,
): void {
  if (proof?.currentPin !== undefined) {
    if (proof.currentPin !== profile.pin) throw new MockProblem("profile_pin_invalid");
  } else if (proof?.currentPassword !== undefined) {
    checkPassword(state, proof.currentPassword);
  } else if (!mockElevated(state)) {
    // Milestone 2: a fresh account-holder proof unlocks any profile, like the password.
    throw new MockProblem("profile_unlock_required");
  }
}

/** Kids profiles are capped at 7+. */
function capForKids(isKids: boolean, level: Maturity): Maturity {
  return isKids && rank(level) > rank(KIDS_MATURITY_CEILING) ? KIDS_MATURITY_CEILING : level;
}

function persist<T>(state: MockState, value: T): T {
  saveState(state);
  return value;
}

// --- Catalogue helpers -------------------------------------------------------------------------

function allowed(profile: MockProfileRecord): MockTitleSeed[] {
  const ceiling = MATURITY_LEVELS.indexOf(profile.maturityCeiling);
  return MOCK_TITLES.filter((seed) => MATURITY_LEVELS.indexOf(seed.maturity) <= ceiling);
}

function viewerOf(profile: MockProfileRecord, id: string): CardViewerState {
  return { inMyList: profile.myList.includes(id), rating: profile.ratings[id] ?? null };
}

function cardOf(
  profile: MockProfileRecord,
  seed: MockTitleSeed,
  view: BrowseView = "home",
  badge?: TitleBadge | null,
): TitleCard {
  return titleCard(seed, viewerOf(profile, titleId(seed)), { view, badge });
}

/**
 * The cards of one list, badged the way the server badges that surface (at most two Top 10
 * badges per list, decided over the whole list so later pages never add more; none in
 * Continue Watching or a ranked row). Grids outside a browse view use Home's Top 10.
 */
function cardsOf(
  profile: MockProfileRecord,
  seeds: readonly MockTitleSeed[],
  view: BrowseView = "home",
  surface: BadgeSurface = "list",
): TitleCard[] {
  const badges = surfaceBadges(seeds, view, surface);
  return seeds.map((seed) => cardOf(profile, seed, view, badges.get(titleId(seed)) ?? null));
}

function progressOf(profile: MockProfileRecord, id: string): Progress | null {
  const entry = profile.progress[id];
  if (!entry) return null;
  return {
    positionSec: entry.positionSec,
    durationSec: entry.durationSec,
    completed: false,
    updatedAt: iso(3_600_000),
  };
}

function episodeRefOf(seed: MockTitleSeed, id: string | null): EpisodeRef | null {
  if (seed.type !== "series") return null;
  const match = id ? /-s(\d+)e(\d+)$/.exec(id) : null;
  let season = Number(match?.[1] ?? 1);
  let number = Number(match?.[2] ?? 1);
  if (!seed.seasons?.[season - 1]?.[number - 1]) {
    season = 1;
    number = 1;
  }
  return {
    id: episodeId(seed, season, number),
    seasonNumber: season,
    number,
    name: seed.seasons?.[season - 1]?.[number - 1] ?? "Episode 1",
  };
}

function pageOf<T>(
  items: T[],
  cursor: string | undefined,
  size = PAGE,
): { items: T[]; nextCursor: string | null } {
  const offset = cursor ? Number(cursor.replace(/^o/, "")) || 0 : 0;
  const slice = items.slice(offset, offset + size);
  return { items: slice, nextCursor: offset + size < items.length ? `o${offset + size}` : null };
}

function shuffled(seeds: MockTitleSeed[], salt: string): MockTitleSeed[] {
  const score = (seed: MockTitleSeed) => {
    let hash = 0;
    for (const char of `${salt}:${seed.slug}`)
      hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
    return hash;
  };
  return [...seeds].sort((a, b) => score(a) - score(b));
}

// --- Rows --------------------------------------------------------------------------------------

type RowBase = Omit<Row, "layout" | "items">;

function rowBase(
  view: BrowseView,
  key: string,
  title: string,
  kind: Row["kind"],
  extra: Partial<RowBase> = {},
): RowBase {
  return {
    id: `${view}.${key}`,
    kind,
    title,
    context: { sourceTitle: null, genre: null },
    link: null,
    nextCursor: null,
    ...extra,
  };
}

function cardRow(base: RowBase, layout: "standard" | "tall", cards: TitleCard[]): Row {
  const page = pageOf(cards, undefined);
  return { ...base, layout, items: page.items, nextCursor: page.nextCursor };
}

function buildRows(view: BrowseView, profile: MockProfileRecord): Row[] {
  const pool = allowed(profile).filter((seed) =>
    view === "series" ? seed.type === "series" : view === "movies" ? seed.type === "movie" : true,
  );
  const cards = (seeds: MockTitleSeed[]) => cardsOf(profile, seeds, view);
  const ranked = (seeds: MockTitleSeed[]): RankedItem[] =>
    cardsOf(profile, seeds, view, "ranked").map((title, index) => ({ rank: index + 1, title }));
  const rows: Row[] = [];

  if (view === "home" || view === "series" || view === "movies") {
    const inProgress = Object.keys(profile.progress)
      .map((id) => seedById.get(id))
      .filter((seed): seed is MockTitleSeed => seed !== undefined && pool.includes(seed));
    if (inProgress.length > 0) {
      const badges = surfaceBadges(inProgress, view, "progress");
      const items: ContinueWatchingItem[] = inProgress.map((seed) => {
        const id = titleId(seed);
        return {
          title: cardOf(profile, seed, view, badges.get(id) ?? null),
          episode: episodeRefOf(seed, profile.progress[id]?.episodeId ?? null),
          progress: progressOf(profile, id) ?? {
            positionSec: 0,
            durationSec: 1,
            completed: false,
            updatedAt: iso(0),
          },
        };
      });
      rows.push({
        ...rowBase(view, "continue", `Continue Watching for ${profile.name}`, "continue-watching"),
        layout: "continue",
        items,
      });
    }
  }

  // Milestone 2: a profile the recommendation model scored gets "Top Picks" after Continue
  // Watching (a kids or lowered-ceiling profile never does: the server uses the rule engine).
  if (mockLearned(profile) && (view === "home" || view === "series" || view === "movies")) {
    const picks = shuffled(pool, `${view}-top-picks-${profile.id}`).slice(0, 18);
    rows.push(
      cardRow(
        rowBase(view, "top-picks", `Top Picks for ${profile.name}`, "top-picks"),
        "standard",
        cards(picks),
      ),
    );
  }

  // One ranked row per view, as the server has it: the overall list on Home, the view's type
  // on Series and Movies (New & Popular shows both typed lists further down).
  if (view === "home" || view === "series" || view === "movies") {
    const list =
      view === "series" ? top10.series : view === "movies" ? top10.movies : top10.overall;
    const seeds = list.filter((seed) => pool.includes(seed));
    const label =
      view === "series"
        ? "Top 10 Series Today"
        : view === "movies"
          ? "Top 10 Movies Today"
          : "Top 10 on Webflix Today";
    if (seeds.length >= 5) {
      rows.push({
        ...rowBase(view, "top10", label, "top-10"),
        layout: "ranked",
        items: ranked(seeds),
      });
    }
  }

  rows.push(
    cardRow(
      rowBase(view, "trending", "Trending Now", "trending"),
      "standard",
      cards(shuffled(pool, `${view}-trending`)),
    ),
  );

  const moviesRanked = top10.movies.filter((seed) => pool.includes(seed));
  if (moviesRanked.length >= 5 && view === "new-popular") {
    rows.push({
      ...rowBase(view, "top10-movies", "Top 10 Movies Today", "top-10"),
      layout: "ranked",
      items: ranked(moviesRanked),
    });
  }

  const originals = pool.filter((seed) => seed.original);
  if (originals.length > 0) {
    rows.push(
      cardRow(rowBase(view, "originals", "Only on Webflix", "originals"), "tall", cards(originals)),
    );
  }

  // Milestone 2: a curated collection staff published on Home, in its curated order.
  if (view === "home") {
    const curated = MOCK_COLLECTION.map((id) => seedById.get(id)).filter(
      (seed): seed is MockTitleSeed => !!seed && pool.includes(seed),
    );
    if (curated.length >= 4) {
      rows.push(
        cardRow(
          rowBase(
            view,
            "collection-after-dark",
            "After Dark: Stories for Late Nights",
            "collection",
          ),
          "standard",
          cards(curated),
        ),
      );
    }
  }

  const newest = [...pool].sort((a, b) => b.year - a.year).slice(0, 16);
  rows.push(
    cardRow(
      rowBase(view, "new", "New Releases", "new-releases", {
        link: { kind: "view", view: "new-popular" },
      }),
      "standard",
      cards(newest),
    ),
  );

  const source = seedById.get("t-sintel");
  if (source && pool.includes(source)) {
    const similar = pool.filter(
      (seed) => seed !== source && seed.genres.some((genre) => source.genres.includes(genre)),
    );
    rows.push(
      cardRow(
        rowBase(
          view,
          "because-sintel",
          `Because you watched ${source.name}`,
          "because-you-watched",
          {
            context: { sourceTitle: { id: titleId(source), name: source.name }, genre: null },
          },
        ),
        "standard",
        cards(similar),
      ),
    );
  }

  const listed = profile.myList
    .map((id) => seedById.get(id))
    .filter((seed): seed is MockTitleSeed => !!seed && pool.includes(seed));
  if (listed.length > 0 && view === "home") {
    rows.push(
      cardRow(
        rowBase(view, "my-list", "My List", "my-list", { link: { kind: "my-list" } }),
        "standard",
        cards(listed),
      ),
    );
  }

  const seriesRanked = top10.series.filter((seed) => pool.includes(seed));
  if (seriesRanked.length >= 5 && view === "new-popular") {
    rows.push({
      ...rowBase(view, "top10-series", "Top 10 Series Today", "top-10"),
      layout: "ranked",
      items: ranked(seriesRanked),
    });
  }

  for (const slug of [
    "thriller",
    "comedy",
    "sci-fi",
    "documentary",
    "animation",
    "drama",
    "crime",
    "family",
  ]) {
    const genre = genreBySlug.get(slug);
    const seeds = pool.filter((seed) => seed.genres.includes(slug));
    if (!genre || seeds.length < 3) continue;
    rows.push(
      cardRow(
        rowBase(view, `genre-${slug}`, genre.name, "genre", {
          link: { kind: "genre", slug },
          context: { sourceTitle: null, genre: { slug, name: genre.name } },
        }),
        "standard",
        cards(shuffled(seeds, slug)),
      ),
    );
  }

  const watched = profile.history
    .map((entry) => seedById.get(entry.titleId))
    .filter((seed): seed is MockTitleSeed => !!seed && pool.includes(seed));
  if (watched.length > 0) {
    rows.push(
      cardRow(
        rowBase(view, "watch-again", "Watch It Again", "watch-again"),
        "standard",
        cards(watched),
      ),
    );
  }
  return rows;
}

const ROWS_PER_PAGE = 6;

/** The mock's curated collection (milestone 2 editorial rows): its titles in curated order. */
const MOCK_COLLECTION = [
  "t-small-hours",
  "t-the-drowned-choir",
  "t-velvet-static",
  "t-undertow",
  "t-the-eleventh-floor",
  "t-cold-ledger",
  "t-house-of-cinders",
  "t-the-wakeful",
  "t-concrete-psalm",
];

/** Whether the mock serves this profile learned recommendations (never kids or lowered ceilings). */
function mockLearned(profile: MockProfileRecord): boolean {
  return !profile.isKids && profile.maturityCeiling === "18+";
}

function billboardSeed(view: BrowseView, profile: MockProfileRecord): MockTitleSeed {
  const pool = allowed(profile);
  const preferred =
    view === "series"
      ? pool.find((seed) => seed.original && seed.type === "series")
      : view === "movies"
        ? pool.find((seed) => seed.original && seed.type === "movie")
        : view === "new-popular"
          ? [...pool].sort((a, b) => b.year - a.year)[0]
          : seedById.get("t-meridian");
  const seed = preferred && pool.includes(preferred) ? preferred : pool[0];
  if (!seed) throw new MockProblem("not_found");
  return seed;
}

// --- Handlers ----------------------------------------------------------------------------------

export const handlers: MockHandlers = {
  getSession: (_input, state) => sessionOf(state),

  getEmailStatus: ({ query }, state) => ({
    next: String(query.email).trim().toLowerCase() === state.account.email ? "login" : "signup",
  }),

  login: ({ body }, state) => {
    if (
      body.email.trim().toLowerCase() !== state.account.email ||
      !identityOf(state).hasPassword ||
      body.password !== state.account.password
    ) {
      throw new MockProblem("invalid_credentials");
    }
    state.signedIn = true;
    state.activeProfileId = null;
    return persist(state, authenticated(state));
  },

  signup: ({ body }, state) => {
    if (body.email.trim().toLowerCase() === state.account.email && state.profiles.length > 0) {
      throw new MockProblem("email_already_registered");
    }
    state.signedIn = true;
    state.account = {
      ...state.account,
      email: body.email.trim().toLowerCase(),
      password: body.password,
    };
    // Milestone 2 (§5.1): the account comes first, without a membership or a card; the plan is
    // chosen and paid at checkout. Milestone 1's `planId` and `payment` are ignored here.
    resetBillingForNewAccount(state);
    state.profiles = [];
    state.activeProfileId = null;
    return persist(state, authenticated(state));
  },

  logout: (_input, state) => {
    state.signedIn = false;
    state.activeProfileId = null;
    persist(state, null);
  },

  logoutAll: (_input, state) => {
    requireAccountHolder(state);
    requireNotDemo(state);
    state.signedIn = false;
    state.activeProfileId = null;
    persist(state, null);
  },

  selectProfile: ({ body }, state) => {
    requireAccount(state);
    const profile = state.profiles.find((candidate) => candidate.id === body.profileId);
    if (!profile) throw new MockProblem("not_found");
    if (profile.pin !== null) {
      if (!body.pin) throw new MockProblem("profile_pin_required");
      if (body.pin !== profile.pin) throw new MockProblem("profile_pin_invalid");
    }
    state.activeProfileId = profile.id;
    return persist(state, authenticated(state));
  },

  clearProfile: (_input, state) => {
    requireAccount(state);
    state.activeProfileId = null;
    return persist(state, authenticated(state));
  },

  getShowcase: () => {
    const ceiling = MATURITY_LEVELS.indexOf(SHOWCASE_MATURITY_CEILING);
    return {
      items: MOCK_TITLES.filter((seed) => MATURITY_LEVELS.indexOf(seed.maturity) <= ceiling)
        .slice(0, SHOWCASE_SIZE)
        .map((seed) => ({
          id: titleId(seed),
          name: seed.name,
          type: seed.type,
          images: {
            card: titleImage(seed, "card"),
            poster: titleImage(seed, "poster"),
            logo: titleImage(seed, "logo"),
            backdrop: titleImage(seed, "backdrop"),
          },
        })),
    };
  },

  updateAccount: ({ body }, state) => {
    requireAccountHolder(state);
    requireNotDemo(state);
    checkPassword(state, body.currentPassword);
    if (body.email && body.email.trim().toLowerCase() !== state.account.email) {
      state.account.email = body.email.trim().toLowerCase();
      identityOf(state).emailVerified = false;
    }
    if (body.newPassword) {
      state.account.password = body.newPassword;
      identityOf(state).hasPassword = true;
    }
    persist(state, null);
    const session = authenticated(state);
    return {
      account: session.account,
      subscription: session.subscription,
      plan: session.plan,
      paymentMethod: paymentMethodOf(state),
    };
  },

  listDevices: (_input, state) => {
    requireAccountHolder(state);
    return {
      items: state.devices.map((device, index) => ({
        ...device,
        current: index === 0,
        createdAt: iso((90 - index * 20) * 86_400_000),
        lastSeenAt: iso(index * 7_200_000),
      })),
    };
  },

  revokeDevice: ({ params }, state) => {
    requireAccountHolder(state);
    if (!state.devices.some((device) => device.id === params.id))
      throw new MockProblem("not_found");
    requireNotDemo(state);
    state.devices = state.devices.filter((device) => device.id !== params.id);
    persist(state, null);
  },

  listProfiles: (_input, state) => {
    requireAccount(state);
    return {
      items: state.profiles.map(toProfile),
      maxProfiles: 5,
      parentalControls: parentalControlsInUse(state),
    };
  },

  createProfile: ({ body }, state) => {
    requireAccount(state);
    requireNotKids(state);
    requireNotDemo(state);
    if (state.profiles.length >= 5) throw new MockProblem("profile_limit_reached");
    if (parentalControlsInUse(state)) checkPassword(state, body.currentPassword);
    const isKids = body.isKids ?? false;
    const record: MockProfileRecord = {
      // Unique even for profiles created within the same millisecond (sign-up creates several).
      id: `profile-${crypto.randomUUID()}`,
      name: body.name.trim(),
      avatarId: body.avatarId,
      isKids,
      maturityCeiling: capForKids(
        isKids,
        body.maturityCeiling ?? (isKids ? KIDS_MATURITY_CEILING : DEFAULT_MATURITY_CEILING),
      ),
      pin: null,
      settings: {
        autoplayNextEpisode: true,
        autoplayPreviews: true,
        subtitleLanguage: null,
        ...body.settings,
      },
      createdAt: iso(0),
      myList: [],
      ratings: {},
      progress: {},
      history: [],
      readNotifications: [],
    };
    state.profiles.push(record);
    return persist(state, toProfile(record));
  },

  updateProfile: ({ params, body }, state) => {
    requireAccount(state);
    const record = state.profiles.find((profile) => profile.id === params.id);
    if (!record) throw new MockProblem("not_found");
    const own = state.activeProfileId === record.id;
    const structural =
      body.name !== undefined ||
      body.avatarId !== undefined ||
      body.isKids !== undefined ||
      body.maturityCeiling !== undefined ||
      body.pin !== undefined;
    if (structural) requireNotDemo(state);
    // A kids profile may change only its own name, avatar and settings.
    const controls =
      body.isKids !== undefined || body.maturityCeiling !== undefined || body.pin !== undefined;
    if (standingOfSession(state) === "kids" && (!own || controls)) {
      throw new MockProblem("unrestricted_profile_required");
    }
    const loosens =
      body.pin !== undefined ||
      (body.isKids === false && record.isKids) ||
      (body.maturityCeiling !== undefined &&
        rank(body.maturityCeiling) > rank(record.maturityCeiling));
    if (loosens) checkPassword(state, body.currentPassword);
    else if ((structural || body.settings !== undefined) && record.pin !== null && !own) {
      checkUnlock(state, record, body);
    }
    if (body.name) record.name = body.name.trim();
    if (body.avatarId) record.avatarId = body.avatarId;
    if (body.isKids !== undefined) record.isKids = body.isKids;
    if (body.maturityCeiling) record.maturityCeiling = body.maturityCeiling;
    record.maturityCeiling = capForKids(record.isKids, record.maturityCeiling);
    if (body.pin !== undefined) record.pin = body.pin;
    if (body.settings) record.settings = { ...record.settings, ...body.settings };
    return persist(state, toProfile(record));
  },

  deleteProfile: ({ params, body }, state) => {
    requireAccount(state);
    const record = state.profiles.find((profile) => profile.id === params.id);
    if (!record) throw new MockProblem("not_found");
    requireNotKids(state);
    requireNotDemo(state);
    if (state.profiles.length <= 1) throw new MockProblem("profile_last_remaining");
    if (record.pin !== null && state.activeProfileId !== record.id) {
      checkUnlock(state, record, body);
    }
    state.profiles = state.profiles.filter((profile) => profile.id !== params.id);
    if (state.activeProfileId === params.id) state.activeProfileId = null;
    persist(state, null);
  },

  listAvatars: (_input, state) => {
    requireAccount(state);
    return avatarCatalog();
  },

  // --- Milestone 2 sign-in (mocks/identity.ts) -------------------------------------------------

  listSignInProviders: () => ({
    items: [
      { id: "google", displayName: "Google" },
      { id: "apple", displayName: "Apple" },
    ],
  }),

  getElevation: (_input, state) => {
    requireAccount(state);
    return elevationOf(state);
  },

  elevate: ({ body }, state) => {
    requireAccount(state);
    if (!identityOf(state).hasPassword) throw new MockProblem("password_required");
    if (body.password !== state.account.password) {
      throw new MockProblem("current_password_invalid");
    }
    elevate(state);
    return persist(state, elevationOf(state));
  },

  listIdentities: (_input, state) => {
    requireAccountHolder(state);
    const identity = identityOf(state);
    return { items: identity.identities, hasPassword: identity.hasPassword };
  },

  unlinkIdentity: ({ params }, state) => {
    requireAccountHolder(state);
    requireNotDemo(state);
    if (!mockElevated(state)) throw new MockProblem("reauthentication_required");
    const identity = identityOf(state);
    if (!identity.identities.some((linked) => linked.provider === params.provider)) {
      throw new MockProblem("not_found");
    }
    if (!identity.hasPassword && identity.identities.length <= 1) {
      throw new MockProblem("identity_last_sign_in_method");
    }
    identity.identities = identity.identities.filter(
      (linked) => linked.provider !== params.provider,
    );
    persist(state, null);
  },

  requestEmailVerification: (_input, state) => {
    requireAccount(state);
  },

  confirmEmailVerification: ({ body }, state) => {
    if (!mockTokenValid(body.token)) throw new MockProblem("verification_token_invalid");
    identityOf(state).emailVerified = true;
    persist(state, null);
  },

  requestPasswordReset: () => undefined,

  confirmPasswordReset: ({ body }, state) => {
    if (!mockTokenValid(body.token)) throw new MockProblem("verification_token_invalid");
    requireNotDemo(state);
    state.account.password = body.newPassword;
    const identity = identityOf(state);
    identity.hasPassword = true;
    identity.emailVerified = true;
    identity.elevatedUntil = null;
    // Every device is signed out, this one too.
    state.signedIn = false;
    state.activeProfileId = null;
    persist(state, null);
  },

  getBrowse: ({ query }, state) => {
    const profile = requireProfile(state);
    const view = query?.view ?? "home";
    const rows = buildRows(view, profile);
    const offset = query?.cursor ? Number(query.cursor.replace(/^r/, "")) || 0 : 0;
    const seed = billboardSeed(view, profile);
    return {
      view,
      billboard: offset === 0 ? billboardFor(seed, viewerOf(profile, titleId(seed)), view) : null,
      rows: rows.slice(offset, offset + ROWS_PER_PAGE),
      nextCursor: offset + ROWS_PER_PAGE < rows.length ? `r${offset + ROWS_PER_PAGE}` : null,
      // Milestone 2: which ranking policy built the page (never an exploration page in mock mode).
      policy: { id: mockLearned(profile) ? "learned:mock" : "rules", explore: false },
    };
  },

  getBrowseRow: ({ params, query }, state) => {
    const profile = requireProfile(state);
    const [view] = params.rowId.split(".") as [BrowseView];
    const row = buildRows(view, profile).find((candidate) => candidate.id === params.rowId);
    if (!row) throw new MockProblem("not_found");
    if (row.layout !== "standard" && row.layout !== "tall") return { ...row, nextCursor: null };
    const all = row.id.endsWith("trending")
      ? cardsOf(profile, shuffled(allowed(profile), `${view}-trending`), view)
      : row.items;
    const page = pageOf(all, query?.cursor);
    return { ...row, items: page.items, nextCursor: page.nextCursor };
  },

  listGenres: (_input, state) => {
    requireProfile(state);
    return { items: allGenres() };
  },

  getGenreBrowse: ({ params, query }, state) => {
    const profile = requireProfile(state);
    const genre = allGenres().find((candidate) => candidate.slug === params.slug);
    if (!genre) throw new MockProblem("not_found");
    let seeds = allowed(profile).filter((seed) => seed.genres.includes(params.slug));
    if (query?.type) seeds = seeds.filter((seed) => seed.type === query.type);
    const sort = query?.sort ?? "suggested";
    if (sort === "newest") seeds.sort((a, b) => b.year - a.year);
    if (sort === "oldest") seeds.sort((a, b) => a.year - b.year);
    if (sort === "a-z") seeds.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "z-a") seeds.sort((a, b) => b.name.localeCompare(a.name));
    const page = pageOf(cardsOf(profile, seeds), query?.cursor);
    return { genre, type: query?.type ?? null, sort, ...page };
  },

  getTitle: ({ params }, state) => {
    const profile = requireProfile(state);
    const seed = seedById.get(params.id);
    if (!seed) throw new MockProblem("not_found");
    if (!allowed(profile).includes(seed)) {
      throw new MockProblem("maturity_restricted", {
        maturity: seed.maturity,
        profileMaturityCeiling: profile.maturityCeiling,
      });
    }
    return titleDetail(seed, {
      ...viewerOf(profile, params.id),
      progress: progressOf(profile, params.id),
    });
  },

  listEpisodes: ({ params }, state) => {
    const profile = requireProfile(state);
    const seed = seedById.get(params.id);
    const season = Number(params.seasonNumber);
    if (!seed?.seasons?.[season - 1]) throw new MockProblem("not_found");
    const progress = profile.progress[params.id];
    const items = episodesOf(seed, season, (id) =>
      progress?.episodeId === id
        ? {
            positionSec: progress.positionSec,
            durationSec: progress.durationSec,
            completed: false,
            updatedAt: iso(3_600_000),
          }
        : null,
    );
    return {
      titleId: params.id,
      season: {
        number: season,
        name: `Season ${season}`,
        episodeCount: items.length,
        releaseYear: seed.year + season - 1,
      },
      items,
    };
  },

  listSimilar: ({ params }, state) => {
    const profile = requireProfile(state);
    const seed = seedById.get(params.id);
    if (!seed) throw new MockProblem("not_found");
    const similar = allowed(profile)
      .filter(
        (candidate) =>
          candidate !== seed && candidate.genres.some((genre) => seed.genres.includes(genre)),
      )
      .slice(0, 12);
    return { items: cardsOf(profile, similar) };
  },

  search: ({ query }, state) => {
    const profile = requireProfile(state);
    const q = String(query.q).trim().toLowerCase();
    const matches = allowed(profile).filter(
      (seed) =>
        seed.name.toLowerCase().includes(q) ||
        seed.genres.some((genre) => genre.includes(q)) ||
        seed.moods.some((mood) => mood.toLowerCase().includes(q)) ||
        seed.cast.some((member) => member.name.toLowerCase().includes(q)),
    );
    const page = pageOf(cardsOf(profile, matches), query.cursor);
    const people = MOCK_TITLES.flatMap((seed) => seed.cast)
      .filter((member) => member.name.toLowerCase().includes(q))
      .slice(0, 3)
      .map((member) => ({
        kind: "person" as const,
        id: `p-${member.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 64),
        name: member.name,
      }));
    const genres = allGenres()
      .filter((genre) => genre.name.toLowerCase().includes(q))
      .slice(0, 3)
      .map((genre) => ({ kind: "genre" as const, slug: genre.slug, name: genre.name }));
    const titles = matches
      .slice(0, 4)
      .map((seed) => ({ kind: "title" as const, id: titleId(seed), name: seed.name }));
    return {
      query: String(query.q),
      results: page.items,
      suggestions: [...titles, ...people, ...genres],
      nextCursor: page.nextCursor,
    };
  },

  getMyList: ({ query }, state) => {
    const profile = requireProfile(state);
    const seeds = [...profile.myList]
      .reverse()
      .map((id) => seedById.get(id))
      .filter((seed): seed is MockTitleSeed => !!seed);
    return pageOf(cardsOf(profile, seeds), query?.cursor);
  },

  addToMyList: ({ params }, state) => {
    const profile = requireProfile(state);
    if (!seedById.has(params.titleId)) throw new MockProblem("not_found");
    if (!profile.myList.includes(params.titleId)) profile.myList.push(params.titleId);
    persist(state, null);
  },

  removeFromMyList: ({ params }, state) => {
    const profile = requireProfile(state);
    profile.myList = profile.myList.filter((id) => id !== params.titleId);
    persist(state, null);
  },

  rateTitle: ({ params, body }, state) => {
    const profile = requireProfile(state);
    if (!seedById.has(params.titleId)) throw new MockProblem("not_found");
    profile.ratings[params.titleId] = body.value;
    persist(state, null);
  },

  clearRating: ({ params }, state) => {
    const profile = requireProfile(state);
    delete profile.ratings[params.titleId];
    persist(state, null);
  },

  getContinueWatching: (_input, state) => {
    const profile = requireProfile(state);
    const row = buildRows("home", profile).find((candidate) => candidate.layout === "continue");
    return { items: row?.layout === "continue" ? row.items : [] };
  },

  removeFromContinueWatching: ({ params }, state) => {
    const profile = requireProfile(state);
    delete profile.progress[params.titleId];
    persist(state, null);
  },

  getHistory: ({ query }, state) => {
    const profile = requireProfile(state);
    const items = profile.history.flatMap((entry) => {
      const seed = seedById.get(entry.titleId);
      if (!seed) return [];
      return [
        {
          id: entry.id,
          watchedAt: entry.watchedAt,
          title: { id: entry.titleId, name: seed.name, type: seed.type },
          episode: episodeRefOf(seed, entry.episodeId),
        },
      ];
    });
    return pageOf(items, query?.cursor);
  },

  removeHistoryEntry: ({ params }, state) => {
    const profile = requireProfile(state);
    if (!profile.history.some((entry) => entry.id === params.id))
      throw new MockProblem("not_found");
    profile.history = profile.history.filter((entry) => entry.id !== params.id);
    persist(state, null);
  },

  listNotifications: (_input, state): NotificationList => {
    const profile = requireProfile(state);
    const picks = ["t-kingdom-of-moths", "t-parallax", "t-chrome-lotus", "t-pocket-moon"]
      .map((id) => seedById.get(id))
      .filter((seed): seed is MockTitleSeed => !!seed);
    const items = picks.map((seed, index) => ({
      id: `n-${seed.slug}`,
      kind:
        (["new-arrival", "new-episodes", "coming-soon", "top-10"] as const)[index % 4] ??
        "new-arrival",
      createdAt: iso((index * 26 + 2) * 3_600_000),
      readAt: profile.readNotifications.includes(`n-${seed.slug}`) ? iso(0) : null,
      headline:
        ["New Arrival", "New Episodes", "Coming Soon", "Top 10 Today"][index % 4] ?? "New Arrival",
      body: seed.name,
      title: { id: titleId(seed), name: seed.name },
      image: titleImage(seed, "card"),
    }));
    return { items, unreadCount: items.filter((item) => item.readAt === null).length };
  },

  markNotificationsRead: ({ body }, state) => {
    const profile = requireProfile(state);
    const ids =
      body.ids ??
      ["t-kingdom-of-moths", "t-parallax", "t-chrome-lotus", "t-pocket-moon"].map(
        (id) => `n-${id.slice(2)}`,
      );
    profile.readNotifications = [...new Set([...profile.readNotifications, ...ids])];
    persist(state, null);
  },

  createPlaybackSession: ({ body }, state) => {
    const profile = requireProfile(state);
    requireEntitled(state, (code, extensions) => new MockProblem(code, extensions));
    const seed = seedById.get(body.titleId);
    if (!seed) throw new MockProblem("not_found");
    const progress = profile.progress[body.titleId];
    const episode = episodeRefOf(seed, body.episodeId ?? progress?.episodeId ?? null);
    const assetId = `asset-${seed.slug}`.slice(0, 64);
    return {
      id: `ps-${Date.now().toString(36)}`,
      titleId: body.titleId,
      episodeId: episode?.id ?? null,
      // Mock mode has no media: the player gets a URL that 404s and must show its error state.
      manifestUrl: `/media/mock-token/vod/${assetId}/master.m3u8`,
      expiresAt: iso(-6 * 3_600_000),
      durationSec: progress?.durationSec ?? (seed.runtimeMin ?? 45) * 60,
      resumePositionSec: body.startPositionSec ?? progress?.positionSec ?? 0,
      textTracks: [],
      trickPlay: null,
      markers: {
        intro: seed.type === "series" ? { startSec: 30, endSec: 95 } : null,
        recap: null,
        creditsStartSec: null,
      },
      nextEpisode: null,
      heartbeatIntervalSec: 30,
      maxVideoHeight: 1080,
      autoplayNextEpisode: profile.settings.autoplayNextEpisode,
      display: {
        titleName: seed.name,
        titleType: seed.type,
        episode,
        maturity: seed.maturity,
        maturityDescriptors: seed.maturityDescriptors,
        logo: titleImage(seed, "logo"),
      },
    };
  },

  sendHeartbeat: ({ body }, state) => {
    requireProfile(state);
    void body;
    return { heartbeatIntervalSec: 30 };
  },

  endPlaybackSession: (_input, state) => {
    requireProfile(state);
  },

  // --- Milestone 2 billing (mocks/billing.ts) ---------------------------------------------------
  ...createBillingHandlers({
    problem: (code, extensions) => new MockProblem(code, extensions),
    requireAccount,
    requireAccountHolder,
    requireNotDemo,
    unrestricted: (state) => {
      const standing = standingOfSession(state);
      return standing === "gate" || standing === "unrestricted";
    },
    session: authenticated,
    persist: (state) => saveState(state),
  }),
};
