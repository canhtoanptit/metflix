import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { BrowseView, GenreSort, TitleType } from "@webflix/contracts";
import { api } from "../api.ts";
import { qk } from "./keys.ts";

const MINUTE = 60_000;

/**
 * Query options for every GET endpoint of the contract. Use them with `useQuery`,
 * `useSuspenseQuery`, `queryClient.prefetchQuery` / `ensureQueryData` (route loaders):
 *
 *   const { data } = useQuery(queries.title(titleId));
 *
 * The abort signal is always forwarded, so leaving a screen cancels its requests.
 */
export const queries = {
  session: () =>
    queryOptions({
      queryKey: qk.session(),
      queryFn: ({ signal }) => api().getSession(undefined, { signal }),
      staleTime: 5 * MINUTE,
      // Every first paint waits on this: fail fast to the "can't reach" page, retry once.
      retry: 1,
      retryDelay: 400,
    }),
  plans: () =>
    queryOptions({
      queryKey: qk.plans(),
      queryFn: ({ signal }) => api().listPlans(undefined, { signal }),
      staleTime: 60 * MINUTE,
    }),
  /** The sign-in issuers this deployment offers, in button order (public, cacheable). */
  signInProviders: () =>
    queryOptions({
      queryKey: qk.signInProviders(),
      queryFn: ({ signal }) => api().listSignInProviders(undefined, { signal }),
      staleTime: 60 * MINUTE,
    }),
  /** The payment provider the browser faces (`fake`, `stripe` or `none`): configuration. */
  billingConfig: () =>
    queryOptions({
      queryKey: qk.billingConfig(),
      queryFn: ({ signal }) => api().getBillingConfig(undefined, { signal }),
      staleTime: 60 * MINUTE,
    }),

  // --- Account scope ---------------------------------------------------------------------------
  account: () =>
    queryOptions({
      queryKey: qk.account.details(),
      queryFn: ({ signal }) => api().getAccount(undefined, { signal }),
    }),
  /** The account's checkout in progress (any device), or `{ checkout: null }`. Always fresh. */
  openCheckout: () =>
    queryOptions({
      queryKey: qk.account.openCheckout(),
      queryFn: ({ signal }) => api().getOpenCheckout(undefined, { signal }),
      staleTime: 0,
    }),
  /** Invoices and receipts, newest first; follow `nextCursor` for older ones. */
  invoices: () =>
    infiniteQueryOptions({
      queryKey: qk.account.invoices(),
      queryFn: ({ pageParam, signal }) =>
        api().listInvoices({ query: { cursor: pageParam } }, { signal }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  devices: () =>
    queryOptions({
      queryKey: qk.account.devices(),
      queryFn: ({ signal }) => api().listDevices(undefined, { signal }),
    }),
  /** Linked sign-in issuers and whether the account has a password. */
  identities: () =>
    queryOptions({
      queryKey: qk.account.identities(),
      queryFn: ({ signal }) => api().listIdentities(undefined, { signal }),
    }),
  /** The session's account-holder proof and the ways this account can give one. */
  elevation: () =>
    queryOptions({
      queryKey: qk.account.elevation(),
      queryFn: ({ signal }) => api().getElevation(undefined, { signal }),
      // Read fresh whenever a sensitive action asks: the proof expires on its own.
      staleTime: 0,
    }),
  profiles: () =>
    queryOptions({
      queryKey: qk.account.profiles(),
      queryFn: ({ signal }) => api().listProfiles(undefined, { signal }),
    }),
  avatars: () =>
    queryOptions({
      queryKey: qk.account.avatars(),
      queryFn: ({ signal }) => api().listAvatars(undefined, { signal }),
      staleTime: 60 * MINUTE,
    }),

  // --- Profile scope -----------------------------------------------------------------------------
  /** Billboard and rows of a view; pages of rows load as the user scrolls (`fetchNextPage`). */
  browse: (view: BrowseView) =>
    infiniteQueryOptions({
      queryKey: qk.profile.browse(view),
      queryFn: ({ pageParam, signal }) =>
        api().getBrowse({ query: { view, cursor: pageParam } }, { signal }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      staleTime: 2 * MINUTE,
    }),
  /** Further items of one row (the first page arrives inside the browse response). */
  row: (rowId: string, firstCursor: string) =>
    infiniteQueryOptions({
      queryKey: qk.profile.row(rowId),
      queryFn: ({ pageParam, signal }) =>
        api().getBrowseRow({ params: { rowId }, query: { cursor: pageParam } }, { signal }),
      initialPageParam: firstCursor,
      getNextPageParam: (row) => row.nextCursor ?? undefined,
    }),
  genres: () =>
    queryOptions({
      queryKey: qk.profile.genres(),
      queryFn: ({ signal }) => api().listGenres(undefined, { signal }),
      staleTime: 30 * MINUTE,
    }),
  genre: (slug: string, filters: { type?: TitleType; sort?: GenreSort } = {}) =>
    infiniteQueryOptions({
      queryKey: qk.profile.genre(slug, filters),
      queryFn: ({ pageParam, signal }) =>
        api().getGenreBrowse(
          { params: { slug }, query: { ...filters, cursor: pageParam } },
          { signal },
        ),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  title: (id: string) =>
    queryOptions({
      queryKey: qk.profile.title(id),
      queryFn: ({ signal }) => api().getTitle({ params: { id } }, { signal }),
    }),
  episodes: (id: string, seasonNumber: number) =>
    queryOptions({
      queryKey: qk.profile.episodes(id, seasonNumber),
      queryFn: ({ signal }) => api().listEpisodes({ params: { id, seasonNumber } }, { signal }),
    }),
  similar: (id: string) =>
    queryOptions({
      queryKey: qk.profile.similar(id),
      queryFn: ({ signal }) => api().listSimilar({ params: { id } }, { signal }),
      staleTime: 10 * MINUTE,
    }),
  /** Search as you type: keep the previous results on screen while the next query loads. */
  search: (query: string) =>
    infiniteQueryOptions({
      queryKey: qk.profile.search(query),
      queryFn: ({ pageParam, signal }) =>
        api().search({ query: { q: query, cursor: pageParam } }, { signal }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      enabled: query.trim().length > 0,
      staleTime: MINUTE,
    }),
  myList: () =>
    infiniteQueryOptions({
      queryKey: qk.profile.myList(),
      queryFn: ({ pageParam, signal }) =>
        api().getMyList({ query: { cursor: pageParam } }, { signal }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  continueWatching: () =>
    queryOptions({
      queryKey: qk.profile.continueWatching(),
      queryFn: ({ signal }) => api().getContinueWatching(undefined, { signal }),
    }),
  history: () =>
    infiniteQueryOptions({
      queryKey: qk.profile.history(),
      queryFn: ({ pageParam, signal }) =>
        api().getHistory({ query: { cursor: pageParam } }, { signal }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  notifications: () =>
    queryOptions({
      queryKey: qk.profile.notifications(),
      queryFn: ({ signal }) => api().listNotifications(undefined, { signal }),
      refetchInterval: 5 * MINUTE,
    }),
};
