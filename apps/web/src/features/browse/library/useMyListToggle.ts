import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TitleCard } from "@webflix/contracts";
import { toast } from "@webflix/ui";
import { api } from "../../../app/api.ts";
import { qk } from "../../../app/query/keys.ts";
import { optimisticUpdate, patchTitleViewer } from "../../../app/query/optimistic.ts";
import { useTelemetryScope } from "../../../app/telemetry/index.ts";
import { track } from "../common/telemetry.ts";
import { findCachedCard, markBrowseStale, patchMyListMembership } from "./cache.ts";

export interface MyListToggleVariables {
  titleId: string;
  add: boolean;
  name?: string;
  /** The card to insert into My List rows/pages when adding (looked up in the cache if omitted). */
  card?: TitleCard | null;
  /** Offer "Undo" in a toast (removals from the My List page, where the card disappears). */
  undoable?: boolean;
}

/**
 * Add/remove a title from My List — the reference implementation of the optimistic-update
 * pattern (blueprint §9). Every cached card and detail for the title flips instantly, the My
 * List page and My List rows gain or lose the card, a failure rolls everything back and says
 * so, and the server's order is fetched afterwards.
 */
export function useMyListToggle() {
  const queryClient = useQueryClient();
  // Where the change was made (a card's preview reports its row and place; the details, the
  // title page): reported once the server has it.
  const where = useTelemetryScope();
  const mutation = useMutation({
    mutationFn: ({ titleId, add }: MyListToggleVariables) =>
      add
        ? api().addToMyList({ params: { titleId } })
        : api().removeFromMyList({ params: { titleId } }),
    onMutate: async ({ titleId, add, card }) => {
      // Captured before the card leaves the cache, so "Undo" can put it back in place.
      const source = card ?? findCachedCard(queryClient, titleId);
      const rollback = await optimisticUpdate(queryClient, qk.profile.all(), (data, key) =>
        patchMyListMembership(
          patchTitleViewer(data, titleId, { inMyList: add }),
          key,
          titleId,
          source,
          add,
        ),
      );
      return { rollback, card: source };
    },
    onError: (_error, { add, name }, context) => {
      context?.rollback();
      toast.error(add ? "Couldn't add to My List" : "Couldn't remove from My List", {
        description: name ? `${name} is unchanged. Please try again.` : "Please try again.",
      });
    },
    onSuccess: (_data, variables, context) => {
      track(variables.add ? "list.add" : "list.remove", { titleId: variables.titleId }, where);
      if (!variables.add && variables.undoable) {
        toast.show({
          id: `my-list-${variables.titleId}`,
          title: "Removed from My List",
          description: variables.name,
          action: {
            label: "Undo",
            altText: "Add it back from the title's details",
            onClick: () =>
              mutation.mutate({ ...variables, card: context.card, add: true, undoable: false }),
          },
        });
      }
    },
    onSettled: () => {
      markBrowseStale(queryClient);
      return queryClient.invalidateQueries({ queryKey: qk.profile.myList() });
    },
  });
  return mutation;
}
