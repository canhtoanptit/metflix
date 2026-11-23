import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@webflix/ui";
import { api } from "../../../app/api.ts";
import { qk } from "../../../app/query/keys.ts";
import { optimisticUpdate } from "../../../app/query/optimistic.ts";
import { markBrowseStale, removeContinueWatching } from "./cache.ts";

/**
 * "Remove from row" on Continue Watching. The card leaves every Continue Watching row at once;
 * the server hides it until the title is watched again (there is nothing to undo to).
 */
export function useRemoveFromContinueWatching() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ titleId }: { titleId: string; name?: string }) =>
      api().removeFromContinueWatching({ params: { titleId } }),
    onMutate: ({ titleId }) =>
      optimisticUpdate(queryClient, qk.profile.all(), (data, key) =>
        removeContinueWatching(data, key, titleId),
      ),
    onError: (_error, { titleId, name }, rollback) => {
      rollback?.();
      toast.error("Couldn't remove it from Continue Watching", {
        id: `continue-watching-${titleId}`,
        description: name ? `${name} is still in the row. Please try again.` : "Please try again.",
      });
    },
    onSuccess: (_data, { titleId, name }) => {
      toast.show({
        id: `continue-watching-${titleId}`,
        title: "Removed from Continue Watching",
        description: name ? `${name} will come back if you watch it again.` : undefined,
      });
    },
    onSettled: () => markBrowseStale(queryClient),
  });
}
