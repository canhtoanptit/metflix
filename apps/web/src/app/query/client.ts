import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "@webflix/contracts";
import { toast } from "@webflix/ui";
import { describeError, isRetryableError } from "./errors.ts";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /** Do not toast when a background refetch of this query fails. */
      silent?: boolean;
    };
    mutationMeta: {
      /** The mutation reports its own errors (inline); skip the global toast. */
      silent?: boolean;
    };
  }
}

export interface SessionErrorHandlers {
  /** The session ended (expired, revoked, signed out elsewhere). */
  onUnauthenticated: () => void;
  /** The server says no profile is active for this session. */
  onProfileRequired: () => void;
}

/**
 * The app's QueryClient. Conventions it enforces:
 * - 4xx answers are never retried; network and 5xx failures retry twice with backoff.
 * - `unauthenticated` / `profile_required` from any request reset the session, and the route
 *   guards redirect (sign in / Who's watching?).
 * - A failed *background* refetch (data already on screen) shows one toast; first loads render
 *   their own error state. Mutations toast unless they handle errors (`meta: { silent: true }`
 *   or their own `onError`).
 */
export function createQueryClient(handlers: SessionErrorHandlers): QueryClient {
  const handleSessionErrors = (error: unknown) => {
    if (ApiError.is(error, "unauthenticated")) handlers.onUnauthenticated();
    else if (ApiError.is(error, "profile_required")) handlers.onProfileRequired();
  };
  const isSessionError = (error: unknown) =>
    ApiError.is(error, "unauthenticated") || ApiError.is(error, "profile_required");

  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        handleSessionErrors(error);
        if (isSessionError(error) || query.meta?.silent || query.state.data === undefined) return;
        const { title, description } = describeError(error);
        toast.error(title, { description, id: "background-refresh" });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        handleSessionErrors(error);
        if (isSessionError(error) || mutation.meta?.silent || mutation.options.onError) return;
        const { title, description } = describeError(error);
        toast.error(title, { description });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: (failureCount, error) => isRetryableError(error) && failureCount < 2,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
