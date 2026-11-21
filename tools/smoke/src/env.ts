/**
 * Per-run environment: agent factory, fixtures (accounts, profiles, titles, playback) and
 * memoised facts about the target. Shared fixtures are created lazily by the first check that
 * needs them, inside that check's scope, so their requests show up in its report.
 */
import { randomBytes } from "node:crypto";
import {
  type AuthenticatedSession,
  type BrowseView,
  type Genre,
  MOCK_CARDS,
  type MockCardPayment,
  type PlanId,
  type PlaybackSession,
  type Profile,
  type TitleCard,
} from "@webflix/contracts";
import { CheckFailure, check, describeError, fail, SkipSignal, succeeds } from "./expect.ts";
import {
  type MasterPlaylist,
  type MediaPlaylist,
  parseMaster,
  parseMediaPlaylist,
  resolveUri,
} from "./hls.ts";
import { Agent, isApiError, runDetached } from "./http.ts";
import type { SmokeOptions } from "./types.ts";

export interface TestAccount {
  tag: string;
  email: string;
  password: string;
  /** The device that signed up (holds the sign-up session). */
  agent: Agent;
  session: AuthenticatedSession;
}

export interface Viewer {
  account: TestAccount;
  agent: Agent;
  profile: Profile;
}

export interface CatalogIndex {
  genres: Genre[];
  cards: TitleCard[];
  byId: Map<string, TitleCard>;
}

export interface MediaDiscovery {
  viewer: Viewer;
  packaged: { card: TitleCard } | null;
  external: { card: TitleCard; session: PlaybackSession } | null;
  probed: { titleId: string; kind: "packaged" | "external" | "error"; detail: string }[];
}

export interface PackagedPlayback {
  viewer: Viewer;
  card: TitleCard;
  session: PlaybackSession;
  masterUrl: string;
  master: MasterPlaylist;
  masterText: string;
  /** The lowest-bandwidth variant: what a player starts with. */
  variantUrl: string;
  variant: MediaPlaylist;
  /** Absolute paths (same origin) of a media segment and the init segment. */
  segmentUrl: string;
  initUrl: string | null;
  /** Set when background heartbeats lost the slot (explains later 410s). */
  lost: { at: string; detail: string } | null;
}

export interface WebBuildFact {
  served: boolean;
  evidence: string;
  html: string;
}

export interface DemoFact {
  available: boolean;
  reason: string;
  viewer?: Viewer;
}

/** A card that is approved by the mock billing provider. */
export function approvedCard(): MockCardPayment {
  return {
    method: "card",
    cardNumber: MOCK_CARDS.approved,
    expMonth: 12,
    expYear: new Date().getUTCFullYear() + 3,
    cvc: "123",
    nameOnCard: "Smoke Test",
  };
}

export class Environment {
  readonly options: SmokeOptions;
  readonly password: string;
  private readonly memo = new Map<string, Promise<unknown>>();
  private readonly disposers: (() => Promise<void>)[] = [];
  private readonly usedTitles = new Set<string>();
  private emailCounter = 0;
  /** Facts discovered during the run, printed in the report header. */
  readonly target = new Map<string, string>();

  constructor(options: SmokeOptions) {
    this.options = options;
    this.password = `Smoke-${options.runId}-${randomBytes(6).toString("hex")}`;
  }

  agent(label: string, options: { retryOn429?: boolean } = {}): Agent {
    return new Agent({
      baseUrl: this.options.baseUrl,
      label,
      runId: this.options.runId,
      requestTimeoutMs: this.options.requestTimeoutMs,
      retryOn429: options.retryOn429 ?? true,
      ...(this.options.verbose && this.options.log ? { verbose: this.options.log } : {}),
    });
  }

  /** Memoise a shared fixture; a failure is reported to every check that needs it. */
  once<T>(key: string, factory: () => Promise<T>): Promise<T> {
    let promise = this.memo.get(key) as Promise<T> | undefined;
    if (!promise) {
      // Every check that shares the fixture reports the same root cause, labelled as such.
      promise = factory().catch((error: unknown) => {
        if (error instanceof SkipSignal) throw error;
        const described = error instanceof CheckFailure ? error : describeError(error);
        throw new CheckFailure(`shared fixture "${key}" failed: ${described.message}`, {
          expected: described.expected,
          observed: described.observed,
          exchange: described.exchange,
          details: described.details ?? [],
        });
      });
      this.memo.set(key, promise);
    }
    return promise;
  }

  onDispose(dispose: () => Promise<void>): void {
    this.disposers.push(dispose);
  }

  async dispose(): Promise<void> {
    for (const dispose of this.disposers.reverse()) {
      await dispose().catch(() => undefined);
    }
  }

  note(key: string, value: string): void {
    this.target.set(key, value);
  }

  // --- Accounts --------------------------------------------------------------------------------

  /** A unique address per run and call, so runs can share a deployment. */
  email(tag: string): string {
    this.emailCounter += 1;
    return `smoke-${this.options.runId}-${tag}-${this.emailCounter}@smoke.webflix.test`;
  }

  async signup(tag: string, options: { plan?: PlanId; label?: string } = {}): Promise<TestAccount> {
    const agent = this.agent(options.label ?? tag);
    const email = this.email(tag);
    const session = await succeeds(
      () =>
        agent.api.signup({
          body: {
            email,
            password: this.password,
            planId: options.plan ?? "premium",
            payment: approvedCard(),
          },
        }),
      `sign up (${tag})`,
    );
    return { tag, email, password: this.password, agent, session };
  }

  /**
   * Give `agent` the account's "known device" cookie (set when the account signed up or signed
   * in): its sign-ins are then exempt from the per-email limit, like a browser that signed in
   * to the account before. The suite's extra devices carry it so only the check that measures
   * the per-email limit (`ratelimit.auth-email`) spends that budget.
   */
  knownDevice(account: TestAccount, agent: Agent): Agent {
    for (const [name, value] of account.agent.jar.snapshot()) {
      if (name.endsWith("webflix_device")) agent.jar.set(name, value);
    }
    return agent;
  }

  /** Sign in the account on a new device (one the account's browsers signed in from before). */
  async login(
    account: TestAccount,
    label: string,
    options: { retryOn429?: boolean } = {},
  ): Promise<Agent> {
    const agent = this.knownDevice(account, this.agent(label, options));
    await succeeds(
      () => agent.api.login({ body: { email: account.email, password: account.password } }),
      `sign in (${label})`,
    );
    return agent;
  }

  avatarId(agent: Agent): Promise<string> {
    return this.once("avatar", async () => {
      const catalog = await succeeds(() => agent.api.listAvatars(), "list avatars");
      const avatar = catalog.groups[0]?.avatars[0];
      check(avatar, "the avatar catalog is empty", { observed: JSON.stringify(catalog) });
      return avatar.id;
    });
  }

  /**
   * Add a profile to the agent's account. While the account has parental controls in use the
   * API asks for the password (`password_required`); every account the suite signs up shares
   * the run's password, which is then sent.
   */
  async createProfile(
    agent: Agent,
    body: { name: string; isKids?: boolean; maturityCeiling?: Profile["maturityCeiling"] },
  ): Promise<Profile> {
    const avatarId = await this.avatarId(agent);
    return succeeds(async () => {
      try {
        return await agent.api.createProfile({ body: { ...body, avatarId } });
      } catch (error) {
        if (!isApiError(error, "password_required")) throw error;
        return agent.api.createProfile({
          body: { ...body, avatarId, currentPassword: this.password },
        });
      }
    }, `create profile ${body.name}`);
  }

  /**
   * Make `agent` (by default the account's sign-up device) an account holder: account
   * management needs an active profile without parental controls. The account's "Holder"
   * profile is created once and selected on the agent.
   */
  async holder(account: TestAccount, agent: Agent = account.agent): Promise<Agent> {
    const profile = await this.once(`holder:${account.email}`, () =>
      this.createProfile(account.agent, { name: "Holder" }),
    );
    await this.selectProfile(agent, profile.id);
    return agent;
  }

  async selectProfile(
    agent: Agent,
    profileId: string,
    pin?: string,
  ): Promise<AuthenticatedSession> {
    return succeeds(
      () =>
        agent.api.selectProfile({ body: pin === undefined ? { profileId } : { profileId, pin } }),
      "select profile",
    );
  }

  /** Sign up, create one profile and select it: what the onboarding flow leaves you with. */
  async viewer(
    tag: string,
    options: {
      plan?: PlanId;
      profile?: { name?: string; isKids?: boolean; maturityCeiling?: Profile["maturityCeiling"] };
    } = {},
  ): Promise<Viewer> {
    const account = await this.signup(tag, options.plan ? { plan: options.plan } : {});
    const profile = await this.createProfile(account.agent, {
      name: options.profile?.name ?? "Smoke",
      ...(options.profile?.isKids === undefined ? {} : { isKids: options.profile.isKids }),
      ...(options.profile?.maturityCeiling === undefined
        ? {}
        : { maturityCeiling: options.profile.maturityCeiling }),
    });
    await this.selectProfile(account.agent, profile.id);
    return { account, agent: account.agent, profile };
  }

  /** Shared read-only viewer (18+ profile) for browse checks. */
  browseViewer(): Promise<Viewer> {
    return this.once("viewer:browse", () => this.viewer("browse"));
  }

  /** An account shared by several checks under `key` (each uses its own device). */
  sharedAccount(key: string, options: { plan?: PlanId } = {}): Promise<TestAccount> {
    return this.once(`account:${key}`, () => this.signup(key, options));
  }

  private pool: { account: TestAccount; profiles: number } | undefined;
  private poolLock: Promise<unknown> = Promise.resolve();

  /**
   * A fresh profile of its own, on its own device: per-profile state (My List, ratings,
   * progress, history, taste) is isolated without a sign-up per check. Accounts are shared
   * four profiles at a time (sign-up is the scarcest budget under strict rate limits, and four
   * profiles streaming at once still fit the Premium plan).
   */
  isolatedViewer(
    tag: string,
    options: { isKids?: boolean; maturityCeiling?: Profile["maturityCeiling"] } = {},
  ): Promise<Viewer> {
    const next = this.poolLock.then(async () => {
      if (!this.pool || this.pool.profiles >= 4) {
        this.pool = { account: await this.signup("pool"), profiles: 0 };
      }
      this.pool.profiles += 1;
      const account = this.pool.account;
      const profile = await this.createProfile(account.agent, {
        name: tag.slice(0, 30),
        ...(options.isKids === undefined ? {} : { isKids: options.isKids }),
        ...(options.maturityCeiling === undefined
          ? {}
          : { maturityCeiling: options.maturityCeiling }),
      });
      return { account, profile };
    });
    this.poolLock = next.catch(() => undefined);
    return next.then(async ({ account, profile }) => {
      const agent = await this.login(account, tag);
      await this.selectProfile(agent, profile.id);
      return { account, agent, profile };
    });
  }

  // --- Catalog -------------------------------------------------------------------------------

  /** Every title visible to an 18+ profile, from the genre pages. */
  catalog(): Promise<CatalogIndex> {
    return this.once("catalog", async () => {
      const viewer = await this.browseViewer();
      const genres = (await succeeds(() => viewer.agent.api.listGenres(), "list genres")).items;
      const byId = new Map<string, TitleCard>();
      for (const genre of genres) {
        let cursor: string | undefined;
        for (let page = 0; page < 20; page += 1) {
          const result = await succeeds(
            () =>
              viewer.agent.api.getGenreBrowse({
                params: { slug: genre.slug },
                query: { limit: 100, ...(cursor ? { cursor } : {}) },
              }),
            `genre page ${genre.slug}`,
          );
          for (const card of result.items) byId.set(card.id, card);
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
      }
      // Titles in no genre still show up on browse rows.
      for (const view of ["home", "movies", "series"] as BrowseView[]) {
        const page = await succeeds(
          () => viewer.agent.api.getBrowse({ query: { view } }),
          `browse ${view}`,
        );
        for (const row of page.rows) {
          for (const item of row.items) {
            const card = "rank" in item ? item.title : "progress" in item ? item.title : item;
            byId.set(card.id, card);
          }
        }
      }
      const cards = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
      check(cards.length > 0, "the catalog is empty for an 18+ profile");
      this.note(
        "catalog",
        `${cards.length} titles visible to an 18+ profile, ${genres.length} genres`,
      );
      return { genres, cards, byId };
    });
  }

  /**
   * Hand out a title no other check of this run has taken (checks sharing an account must not
   * touch each other's titles). `fromEnd`: take it from the end of the catalogue, away from the
   * titles read-only probes start at (checks that measure a title's counters).
   */
  async allocateTitle(
    predicate: (card: TitleCard) => boolean,
    why: string,
    options: { fromEnd?: boolean } = {},
  ): Promise<TitleCard> {
    const { cards } = await this.catalog();
    const card = (options.fromEnd ? [...cards].reverse() : cards).find(
      (candidate) => !this.usedTitles.has(candidate.id) && predicate(candidate),
    );
    if (!card)
      fail(`no unused title matches: ${why}`, {
        observed: `${cards.length} titles in the catalog`,
      });
    this.usedTitles.add(card.id);
    return card;
  }

  // --- Media -----------------------------------------------------------------------------------

  /**
   * Find a packaged title and an external-HLS title by starting playback (one device, so each
   * probe replaces the previous stream). Previews and real artwork are only produced for
   * packaged media, so those titles are tried first.
   */
  media(): Promise<MediaDiscovery> {
    return this.once("media", async () => {
      const viewer = await this.viewer("media");
      const { cards } = await this.catalog();
      const pinned = this.options.mediaTitleId;
      const score = (card: TitleCard) =>
        (card.id === pinned ? 100 : 0) +
        (card.preview ? 10 : 0) +
        (card.images.card.thumbhash ? 5 : 0) +
        (card.type === "movie" ? 1 : 0);
      const candidates = [...cards].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
      const discovery: MediaDiscovery = { viewer, packaged: null, external: null, probed: [] };
      // Without previews/artwork nothing hints at packaged media: probe a bounded number.
      for (const card of candidates.slice(0, 24)) {
        if (discovery.packaged && discovery.external) break;
        try {
          const session = await viewer.agent.api.createPlaybackSession({
            body: { titleId: card.id },
          });
          const packaged = session.manifestUrl.startsWith("/media/");
          discovery.probed.push({
            titleId: card.id,
            kind: packaged ? "packaged" : "external",
            detail: packaged ? "same-origin /media" : new URL(session.manifestUrl).origin,
          });
          if (packaged && !discovery.packaged) discovery.packaged = { card };
          if (!packaged && !discovery.external) discovery.external = { card, session };
          await viewer.agent.api.endPlaybackSession({ params: { id: session.id } });
        } catch (error) {
          discovery.probed.push({
            titleId: card.id,
            kind: "error",
            detail: isApiError(error) ? error.code : String(error),
          });
          if (isApiError(error, "stream_limit_reached")) break;
        }
      }
      this.note(
        "media",
        [
          discovery.packaged
            ? `packaged (${discovery.packaged.card.id})`
            : "no packaged title found",
          discovery.external
            ? `external HLS (${discovery.external.card.id})`
            : "no external title found",
          `${discovery.probed.length} probed`,
        ].join(", "),
      );
      return discovery;
    });
  }

  /**
   * A live packaged playback session that every media check reads from. Kept alive with
   * heartbeats like a player would, so playlist requests keep their stream slot.
   */
  packagedPlayback(): Promise<PackagedPlayback | null> {
    return this.once("playback:packaged", async () => {
      const discovery = await this.media();
      if (!discovery.packaged) return null;
      const { viewer } = discovery;
      const card = discovery.packaged.card;
      const session = await succeeds(
        () => viewer.agent.api.createPlaybackSession({ body: { titleId: card.id } }),
        `start playback of ${card.id}`,
      );
      const fixture: PackagedPlayback = {
        viewer,
        card,
        session,
        masterUrl: session.manifestUrl,
        master: { variants: [], media: [], iFrameVariants: [] },
        masterText: "",
        variantUrl: "",
        variant: { segments: [], map: null, targetDurationSec: null, endList: false },
        segmentUrl: "",
        initUrl: null,
        lost: null,
      };
      this.keepAlive(viewer.agent, session, (detail) => {
        fixture.lost = { at: new Date().toISOString(), detail };
      });

      const master = await viewer.agent.fetch(session.manifestUrl);
      if (master.status !== 200) {
        fail("master playlist of the shared packaged session is not available", {
          expected: "200 application/vnd.apple.mpegurl",
          observed: `${master.status} ${master.exchange.responseBody ?? ""}`,
          exchange: master.exchange,
        });
      }
      fixture.masterText = master.text();
      fixture.master = parseMaster(fixture.masterText);
      const variants = [...fixture.master.variants].sort(
        (a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0),
      );
      const first = variants[0];
      check(first, "the master playlist lists no variant", {
        observed: fixture.masterText.slice(0, 500),
        exchange: master.exchange,
      });
      fixture.variantUrl = resolveUri(session.manifestUrl, first.uri);
      const variant = await viewer.agent.fetch(fixture.variantUrl);
      check(variant.status === 200, "variant playlist is not available", {
        expected: "200",
        observed: `${variant.status} ${variant.exchange.responseBody ?? ""}`,
        exchange: variant.exchange,
      });
      fixture.variant = parseMediaPlaylist(variant.text());
      const segment = fixture.variant.segments[Math.min(1, fixture.variant.segments.length - 1)];
      check(segment, "the variant playlist lists no segment", {
        observed: variant.text().slice(0, 500),
        exchange: variant.exchange,
      });
      fixture.segmentUrl = resolveUri(fixture.variantUrl, segment.uri);
      fixture.initUrl = fixture.variant.map
        ? resolveUri(fixture.variantUrl, fixture.variant.map)
        : null;
      return fixture;
    });
  }

  /** Heartbeat a session in the background until the run ends; then stop it. */
  keepAlive(agent: Agent, session: PlaybackSession, onLost: (detail: string) => void): void {
    const intervalMs = Math.max(2, Math.min(15, session.heartbeatIntervalSec)) * 1000;
    let position = session.resumePositionSec;
    let stopped = false;
    const beat = async () => {
      position = Math.min(position + intervalMs / 1000, Math.max(0, session.durationSec - 1));
      try {
        await agent.api.sendHeartbeat({
          params: { id: session.id },
          body: { positionSec: position, durationSec: session.durationSec, state: "playing" },
        });
      } catch (error) {
        if (!stopped) onLost(isApiError(error) ? `${error.code}: ${error.message}` : String(error));
      }
    };
    const timer = runDetached(() =>
      setInterval(() => {
        void beat();
      }, intervalMs),
    );
    timer.unref();
    this.onDispose(async () => {
      stopped = true;
      clearInterval(timer);
      await runDetached(() => agent.api.endPlaybackSession({ params: { id: session.id } })).catch(
        () => undefined,
      );
    });
  }

  // --- Facts -----------------------------------------------------------------------------------

  /** Is a web build served at `/` (SPA), or is the target API-only? */
  webBuild(): Promise<WebBuildFact> {
    return this.once("fact:web", async () => {
      const result = await this.agent("probe-web").fetch("/", {
        headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      const type = result.headers.get("Content-Type") ?? "";
      const html = type.includes("text/html") ? result.text() : "";
      const served =
        result.status === 200 && type.includes("text/html") && /<script[\s>]/i.test(html);
      const evidence = served
        ? `GET / → 200 text/html with scripts`
        : `GET / → ${result.status} ${type || "(no content type)"}`;
      this.note("web build", served ? "served at /" : `not served (${evidence}): API-only target`);
      return { served, evidence, html };
    });
  }

  /** The seeded demo account, signed in on its own device with its first adult profile. */
  demo(): Promise<DemoFact> {
    return this.once("fact:demo", async () => {
      const agent = this.agent("demo");
      try {
        const session = await agent.api.login({
          body: { email: this.options.demo.email, password: this.options.demo.password },
        });
        const profile = session.profiles.find(
          (candidate) =>
            !candidate.isLocked && !candidate.isKids && candidate.maturityCeiling === "18+",
        );
        if (!profile) {
          return { available: false, reason: "the demo account has no unlocked 18+ profile" };
        }
        await this.selectProfile(agent, profile.id);
        const account: TestAccount = {
          tag: "demo",
          email: this.options.demo.email,
          password: this.options.demo.password,
          agent,
          session,
        };
        this.note("demo account", `${this.options.demo.email} (profile ${profile.name})`);
        return { available: true, reason: "", viewer: { account, agent, profile } };
      } catch (error) {
        if (isApiError(error, "invalid_credentials")) {
          this.note("demo account", "not seeded");
          return {
            available: false,
            reason: `the demo account is not seeded (sign-in as ${this.options.demo.email} answered invalid_credentials)`,
          };
        }
        throw error;
      }
    });
  }
}
