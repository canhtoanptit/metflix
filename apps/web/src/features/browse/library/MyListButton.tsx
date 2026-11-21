import type { TitleCard } from "@webflix/contracts";
import { CheckIcon, cx, IconButton, PlusIcon, Tooltip } from "@webflix/ui";
import { useRef } from "react";
import { pop } from "../common/motion.ts";
import { useMyListToggle } from "./useMyListToggle.ts";

export interface MyListButtonProps {
  title: Pick<TitleCard, "id" | "name"> & { viewer: { inMyList: boolean } };
  /** The card to insert into My List rows when adding (looked up in the cache otherwise). */
  card?: TitleCard | null;
  size?: "sm" | "md" | "lg";
  /** Offer Undo after removing (the My List page, where the card disappears). */
  undoable?: boolean;
  /** Icon over a caption ("My List"), for touch layouts. */
  labelled?: boolean;
  className?: string;
}

/** Add to / remove from My List, optimistic, with a small pop on change. */
export function MyListButton({
  title,
  card,
  size = "md",
  undoable = false,
  labelled = false,
  className,
}: MyListButtonProps) {
  const toggle = useMyListToggle();
  const ref = useRef<HTMLButtonElement>(null);
  const inList = title.viewer.inMyList;
  const label = inList ? `Remove ${title.name} from My List` : `Add ${title.name} to My List`;
  const onClick = () => {
    pop(ref.current?.querySelector("svg"));
    toggle.mutate({ titleId: title.id, add: !inList, name: title.name, card, undoable });
  };

  if (labelled) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={inList}
        onClick={onClick}
        className={cx(
          "focus-ring flex min-w-16 flex-col items-center gap-1.5 rounded-sm px-2 py-1 text-fg",
          className,
        )}
      >
        {inList ? <CheckIcon size="lg" /> : <PlusIcon size="lg" />}
        <span className="type-caption text-fg-muted">My List</span>
      </button>
    );
  }

  return (
    <Tooltip content={inList ? "Remove from My List" : "Add to My List"}>
      <IconButton
        ref={ref}
        label={label}
        icon={inList ? CheckIcon : PlusIcon}
        variant="outline"
        size={size}
        pressed={inList}
        onClick={onClick}
        className={className}
      />
    </Tooltip>
  );
}
