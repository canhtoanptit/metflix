import { QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "@webflix/ui";
import { describeError, isRetryable } from "./errors.ts";

/**
 * Reads retry twice on a network failure or a 5xx (a read is safe to repeat), never on a 4xx.
 * Changes never retry by themselves: whether one may be sent again is the action dialog's
 * decision (idempotency key, audit). A background refresh that fails while data is on screen
 * says so once, without replacing the data.
 */
export function createStaffQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.state.data === undefined) return;
        const { title, description } = describeError(error);
        toast.error(title, { description, id: "background-refresh" });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 10 * 60_000,
        retry: (failureCount, error) => isRetryable(error) && failureCount < 2,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
