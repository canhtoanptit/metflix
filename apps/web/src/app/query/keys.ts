import type { BrowseView, GenreSort, TitleType } from "@webflix/contracts";

/**
 * Query key factory. Keys are grouped by the scope whose change must drop them:
 *
 * - `qk.session()` and `qk.plans()` are global.
 * - `qk.account.*` belongs to the signed-in account: removed on sign-out.
 * - `qk.profile.*` belongs to the active profile (catalogue responses are filtered and
 *   personalised per profile): removed whenever the active profile changes.
 *
 * Always build keys here; invalidate by prefix (`qk.profile.all()`, `qk.profile.titles()`).
 */
export const qk = {
  root: () => ["webflix"] as const,
  session: () => ["webflix", "session"] as const,
  plans: () => ["webflix", "plans"] as const,
  /** The sign-in issuers the deployment offers (`GET /auth/providers`: public, per deployment). */
  signInProviders: () => ["webflix", "sign-in-providers"] as const,
  /** `GET /billing/config`: which payment provider this deployment uses (configuration). */
  billingConfig: () => ["webflix", "billing-config"] as const,

  account: {
    all: () => ["webflix", "account"] as const,
    details: () => ["webflix", "account", "details"] as const,
    /** Billing reads of this account: invoices, checkouts, card changes. */
    billing: () => ["webflix", "account", "billing"] as const,
    invoices: () => ["webflix", "account", "billing", "invoices"] as const,
    /** `GET /billing/checkout`: the account's checkout in progress, on any device. */
    openCheckout: () => ["webflix", "account", "billing", "open-checkout"] as const,
    devices: () => ["webflix", "account", "devices"] as const,
    profiles: () => ["webflix", "account", "profiles"] as const,
    avatars: () => ["webflix", "account", "avatars"] as const,
    /** Linked sign-in issuers (`GET /account/identities`). */
    identities: () => ["webflix", "account", "identities"] as const,
    /** The session's account-holder proof (`GET /session/elevation`). */
    elevation: () => ["webflix", "account", "elevation"] as const,
  },

  profile: {
    all: () => ["webflix", "profile"] as const,
    browse: (view: BrowseView) => ["webflix", "profile", "browse", view] as const,
    row: (rowId: string) => ["webflix", "profile", "row", rowId] as const,
    genres: () => ["webflix", "profile", "genres"] as const,
    genre: (slug: string, filters: { type?: TitleType; sort?: GenreSort } = {}) =>
      ["webflix", "profile", "genre", slug, filters] as const,
    /** Prefix of every title-scoped key (detail, episodes, similar). */
    titles: () => ["webflix", "profile", "title"] as const,
    title: (id: string) => ["webflix", "profile", "title", id] as const,
    episodes: (id: string, season: number) =>
      ["webflix", "profile", "title", id, "season", season] as const,
    similar: (id: string) => ["webflix", "profile", "title", id, "similar"] as const,
    search: (query: string) => ["webflix", "profile", "search", query] as const,
    myList: () => ["webflix", "profile", "my-list"] as const,
    continueWatching: () => ["webflix", "profile", "continue-watching"] as const,
    history: () => ["webflix", "profile", "history"] as const,
    notifications: () => ["webflix", "profile", "notifications"] as const,
  },
} as const;
