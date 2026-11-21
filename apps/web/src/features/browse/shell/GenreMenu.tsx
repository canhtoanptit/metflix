import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "@webflix/ui";
import { useEffect, useRef } from "react";
import { queries } from "../../../app/query/queries.ts";
import {
  type GenreMenuEntryProps,
  GenreTriggerContent,
  genreTriggerClass,
  type HandoverProps,
} from "./menus.tsx";

export type GenreMenuProps = GenreMenuEntryProps & HandoverProps;

/** "Genres ▾": every genre, linking to its page (filtered to `type` when given). */
export function GenreMenu({
  type,
  children = "Genres",
  appearance = "plain",
  defaultOpen = false,
  autoFocus = false,
}: GenreMenuProps) {
  const genres = useQuery(queries.genres());
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus && !defaultOpen) trigger.current?.focus();
  }, []);
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger ref={trigger} className={genreTriggerClass(appearance)}>
        <GenreTriggerContent>{children}</GenreTriggerContent>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto sm:w-dialog-sm sm:columns-2"
      >
        {genres.isPending ? (
          <div className="grid place-items-center p-6">
            <Spinner label="Loading genres" />
          </div>
        ) : genres.isError ? (
          <DropdownMenuItem onSelect={() => genres.refetch()}>
            Couldn't load genres — try again
          </DropdownMenuItem>
        ) : (
          genres.data.items.map((genre) => (
            <DropdownMenuItem key={genre.id} asChild className="break-inside-avoid">
              <Link
                to="/browse/genre/$slug"
                params={{ slug: genre.slug }}
                search={type ? { type } : {}}
              >
                {genre.name}
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
