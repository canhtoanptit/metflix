/**
 * Query options for every read of the staff API. Keys start with `staff`; the whole cache is
 * dropped when the session ends, so nothing a staff member saw outlives their session in memory.
 *
 * Reading a member's record, their privacy view or searching members writes an audit entry
 * (`member.viewed`, `member.privacy_viewed`, `member.searched`). Those reads never refetch on
 * their own (no focus or interval refetch, long stale time): the log records what a person
 * looked at, not how often a tab regained focus. They refresh after an action, or when asked.
 * Reading the audit log and the operators' erasure and export lists is audited too
 * (`audit.read`, `privacy.erasures_listed`, `privacy.exports_listed`): those load when their
 * page opens, and never on focus or reconnect.
 */
import { queryOptions } from "@tanstack/react-query";
import type { AuditQuery, BrowseView, OwnAuditQuery } from "@webflix/contracts";
import { staffApi } from "./client.ts";

const AUDITED_READ = {
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/** An audited list an operator reads when they open its page (fresh then, never behind their back). */
const AUDITED_LIST = {
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export const qk = {
  all: ["staff"] as const,
  me: () => ["staff", "me"] as const,
  members: () => ["staff", "members"] as const,
  memberSearch: (q: string, cursor: string | null) =>
    ["staff", "members", "search", q, cursor] as const,
  member: (accountId: string) => ["staff", "members", accountId] as const,
  memberPrivacy: (accountId: string) => ["staff", "members", accountId, "privacy"] as const,
  plans: () => ["staff", "plans"] as const,
  billboard: (view: BrowseView) => ["staff", "editorial", "billboard", view] as const,
  collections: () => ["staff", "editorial", "collections"] as const,
  experiments: () => ["staff", "experiments"] as const,
  experiment: (key: string) => ["staff", "experiments", key] as const,
  experimentResults: (key: string) => ["staff", "experiments", key, "results"] as const,
  health: () => ["staff", "system", "health"] as const,
  deadLetters: (cursor: string | null) => ["staff", "system", "dead-letters", cursor] as const,
  recommendations: () => ["staff", "system", "recommendations"] as const,
  erasures: () => ["staff", "system", "erasures"] as const,
  exports: () => ["staff", "system", "exports"] as const,
  audit: (query: AuditQuery) => ["staff", "audit", query] as const,
  ownAudit: (query: OwnAuditQuery) => ["staff", "audit", "mine", query] as const,
  titleSearch: (q: string) => ["staff", "titles", "search", q] as const,
  titles: (ids: readonly string[]) => ["staff", "titles", "ids", ids.join(",")] as const,
  titleAvailability: (titleId: string) => ["staff", "titles", titleId, "availability"] as const,
  availabilityOverrides: () => ["staff", "titles", "availability"] as const,
};

export const queries = {
  me: () =>
    queryOptions({
      queryKey: qk.me(),
      queryFn: ({ signal }) => staffApi().getStaffSelf(undefined, { signal }),
      staleTime: 5 * 60_000,
    }),
  memberSearch: (q: string, cursor: string | null) =>
    queryOptions({
      queryKey: qk.memberSearch(q, cursor),
      queryFn: ({ signal }) =>
        staffApi().searchMembers(
          { query: { q, limit: 25, ...(cursor ? { cursor } : {}) } },
          { signal },
        ),
      ...AUDITED_READ,
    }),
  member: (accountId: string) =>
    queryOptions({
      queryKey: qk.member(accountId),
      queryFn: ({ signal }) => staffApi().getMember({ params: { accountId } }, { signal }),
      ...AUDITED_READ,
    }),
  memberPrivacy: (accountId: string) =>
    queryOptions({
      queryKey: qk.memberPrivacy(accountId),
      queryFn: ({ signal }) => staffApi().getMemberPrivacy({ params: { accountId } }, { signal }),
      ...AUDITED_READ,
    }),
  plans: () =>
    queryOptions({
      queryKey: qk.plans(),
      queryFn: ({ signal }) => staffApi().listAdminPlans(undefined, { signal }),
    }),
  billboard: (view: BrowseView) =>
    queryOptions({
      queryKey: qk.billboard(view),
      queryFn: ({ signal }) => staffApi().getBillboard({ params: { view } }, { signal }),
    }),
  collections: () =>
    queryOptions({
      queryKey: qk.collections(),
      queryFn: ({ signal }) => staffApi().listCollections(undefined, { signal }),
    }),
  experiments: () =>
    queryOptions({
      queryKey: qk.experiments(),
      queryFn: ({ signal }) => staffApi().listExperiments(undefined, { signal }),
    }),
  experiment: (key: string) =>
    queryOptions({
      queryKey: qk.experiment(key),
      queryFn: ({ signal }) => staffApi().getExperiment({ params: { key } }, { signal }),
    }),
  experimentResults: (key: string) =>
    queryOptions({
      queryKey: qk.experimentResults(key),
      queryFn: ({ signal }) => staffApi().getExperimentResults({ params: { key } }, { signal }),
    }),
  health: () =>
    queryOptions({
      queryKey: qk.health(),
      queryFn: ({ signal }) => staffApi().getSystemHealth(undefined, { signal }),
      refetchInterval: 30_000,
    }),
  deadLetters: (cursor: string | null) =>
    queryOptions({
      queryKey: qk.deadLetters(cursor),
      queryFn: ({ signal }) =>
        staffApi().listDeadLetters(
          { query: { limit: 25, ...(cursor ? { cursor } : {}) } },
          { signal },
        ),
    }),
  recommendations: () =>
    queryOptions({
      queryKey: qk.recommendations(),
      queryFn: ({ signal }) => staffApi().getRecommendationStatus(undefined, { signal }),
    }),
  erasures: () =>
    queryOptions({
      queryKey: qk.erasures(),
      queryFn: ({ signal }) =>
        staffApi().listPendingErasures({ query: { limit: 500 } }, { signal }),
      ...AUDITED_LIST,
    }),
  exports: () =>
    queryOptions({
      queryKey: qk.exports(),
      queryFn: ({ signal }) => staffApi().listPendingExports({ query: { limit: 500 } }, { signal }),
      ...AUDITED_LIST,
    }),
  audit: (query: AuditQuery) =>
    queryOptions({
      queryKey: qk.audit(query),
      queryFn: ({ signal }) => staffApi().listAuditLog({ query }, { signal }),
      ...AUDITED_LIST,
    }),
  ownAudit: (query: OwnAuditQuery) =>
    queryOptions({
      queryKey: qk.ownAudit(query),
      queryFn: ({ signal }) => staffApi().listOwnAuditLog({ query }, { signal }),
    }),
  /** Titles by name (any maturity, unavailable ones included); the catalogue by name when empty. */
  titleSearch: (q: string) =>
    queryOptions({
      queryKey: qk.titleSearch(q),
      queryFn: ({ signal }) =>
        staffApi().searchTitles({ query: { ...(q ? { q } : {}), limit: 12 } }, { signal }),
      staleTime: 60_000,
    }),
  /** The titles an editor picked, in their order (unknown ids are left out). */
  titles: (ids: readonly string[]) =>
    queryOptions({
      queryKey: qk.titles(ids),
      queryFn: ({ signal }) =>
        staffApi().searchTitles({ query: { ids: ids.join(",") } }, { signal }),
      staleTime: 5 * 60_000,
    }),
  titleAvailability: (titleId: string) =>
    queryOptions({
      queryKey: qk.titleAvailability(titleId),
      queryFn: ({ signal }) => staffApi().getTitleAvailability({ params: { titleId } }, { signal }),
    }),
  availabilityOverrides: () =>
    queryOptions({
      queryKey: qk.availabilityOverrides(),
      queryFn: ({ signal }) => staffApi().listTitleAvailability(undefined, { signal }),
    }),
};
