import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RatingValue } from "@webflix/contracts";
import { toast } from "@webflix/ui";
import { api } from "../../../app/api.ts";
import { qk } from "../../../app/query/keys.ts";
import { optimisticUpdate, patchTitleViewer } from "../../../app/query/optimistic.ts";
import { markBrowseStale } from "./cache.ts";

export interface RateVariables {
  titleId: string;
  /** null clears the rating. */
  value: RatingValue | null;
  name?: string;
}

export const RATING_LABELS: Record<RatingValue, string> = {
  dislike: "Not for me",
  like: "I like this",
  love: "Love this!",
};

/** Rate (or un-rate) a title, optimistically everywhere the title appears. */
export function useRateTitle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ titleId, value }: RateVariables) =>
      value
        ? api().rateTitle({ params: { titleId }, body: { value } })
        : api().clearRating({ params: { titleId } }),
    onMutate: ({ titleId, value }) =>
      optimisticUpdate(queryClient, qk.profile.all(), (data) =>
        patchTitleViewer(data, titleId, { rating: value }),
      ),
    onError: (_error, { name }, rollback) => {
      rollback?.();
      toast.error("Couldn't save your rating", {
        description: name ? `Your rating for ${name} is unchanged.` : "Please try again.",
      });
    },
    onSettled: () => markBrowseStale(queryClient),
  });
}
