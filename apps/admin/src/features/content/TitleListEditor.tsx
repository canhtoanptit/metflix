/**
 * An ordered list of titles: found by name and added, moved up and down, removed, by keyboard
 * as well as pointer; each change is announced. Titles are kept as ids (what the staff API
 * stores) and shown with their name and card, resolved through `GET /titles?ids=`. An id the
 * catalogue no longer knows is shown as such, to be removed.
 *
 * Focus stays where a keyboard user can carry on (UX review 2.7): after Add, on that result's
 * button; after a move, on the same button of the moved title (its other arrow once it reaches
 * the top or the bottom), so moving a title five places is five presses of Enter; after Remove,
 * on the Remove button of the title that took its place (or the one before it, or the search
 * field once the list is empty).
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { StaffTitle } from "@webflix/contracts";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  IconButton,
} from "@webflix/ui";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { queries } from "../../api/queries.ts";
import { TitleSearch, TitleThumb, titleLine } from "./TitleSearch.tsx";

/** The titles behind `ids`, by id (absent while loading or when the catalogue lacks one). */
export function useTitles(ids: readonly string[]): {
  byId: Map<string, StaffTitle>;
  loading: boolean;
} {
  const titles = useQuery({
    ...queries.titles(ids),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
  });
  return {
    byId: new Map((titles.data?.items ?? []).map((title) => [title.id, title])),
    loading: ids.length > 0 && titles.isPending,
  };
}

export function TitleRow({
  id,
  title,
  loading,
  position,
}: {
  id: string;
  title: StaffTitle | undefined;
  loading: boolean;
  position?: number;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      {position !== undefined ? (
        <span className="w-5 shrink-0 type-caption tabular-nums text-fg-subtle">{position}</span>
      ) : null}
      {title ? (
        <TitleThumb title={title} />
      ) : (
        <span className="aspect-video w-16 shrink-0 rounded-xs bg-surface-3" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="line-clamp-2 break-words type-body-sm font-semibold text-fg">
          {title?.name ?? (loading ? "Loading…" : id)}
        </span>
        <span className="type-caption text-fg-subtle">
          {title ? (
            titleLine(title)
          ) : loading ? (
            id
          ) : (
            <span className="inline-flex items-center gap-1 text-warning">
              <AlertTriangleIcon size="xs" /> Not in the catalog
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

type Control = "up" | "down" | "remove";

export function TitleListEditor({
  value,
  onChange,
  max,
  label = "Titles, in order",
  error,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  max: number;
  label?: string;
  error?: string | null;
}) {
  const [announcement, setAnnouncement] = useState("");
  const [known, setKnown] = useState<Map<string, StaffTitle>>(() => new Map());
  const listId = useId();
  const resolved = useTitles(value);
  const titleOf = (id: string) => resolved.byId.get(id) ?? known.get(id);
  const nameOf = (id: string) => titleOf(id)?.name ?? id;
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const searchField = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<{ id: string; control: Control } | "search" | null>(null);
  const controlRef = (id: string, control: Control) => (element: HTMLButtonElement | null) => {
    const key = `${id}:${control}`;
    if (element) controls.current.set(key, element);
    else controls.current.delete(key);
  };

  // After the list re-renders with a change, put focus where the change asked for it.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === "search") {
      searchField.current?.focus();
      return;
    }
    const wanted = controls.current.get(`${target.id}:${target.control}`);
    const other =
      target.control === "up"
        ? controls.current.get(`${target.id}:down`)
        : target.control === "down"
          ? controls.current.get(`${target.id}:up`)
          : undefined;
    const element = wanted && !wanted.disabled ? wanted : other && !other.disabled ? other : wanted;
    element?.focus();
  }, [value]);

  function add(title: StaffTitle): void {
    if (value.includes(title.id) || value.length >= max) return;
    setKnown((current) => new Map(current).set(title.id, title));
    onChange([...value, title.id]);
    setAnnouncement(`Added ${title.name}, position ${value.length + 1} of ${value.length + 1}.`);
  }

  function move(index: number, by: -1 | 1): void {
    const target = index + by;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(target, 0, item);
    pendingFocus.current = { id: item, control: by < 0 ? "up" : "down" };
    onChange(next);
    setAnnouncement(`${nameOf(item)} moved to position ${target + 1} of ${next.length}.`);
  }

  function remove(index: number): void {
    const item = value[index];
    const next = value.filter((_, position) => position !== index);
    const neighbour = next[index] ?? next[index - 1];
    pendingFocus.current = neighbour ? { id: neighbour, control: "remove" } : "search";
    onChange(next);
    if (item) setAnnouncement(`Removed ${nameOf(item)}.`);
  }

  return (
    <div className="flex flex-col gap-3">
      <span id={listId} className="type-label text-fg">
        {label}{" "}
        <span className="type-caption text-fg-subtle">
          ({value.length} of {max})
        </span>
      </span>
      {value.length > 0 ? (
        <ol aria-labelledby={listId} className="flex flex-col gap-1">
          {value.map((id, index) => (
            <li
              key={id}
              className="flex items-center gap-2 rounded-md border border-line-subtle bg-surface-2 py-1 ps-2 pe-1"
            >
              <TitleRow
                id={id}
                title={titleOf(id)}
                loading={resolved.loading}
                position={index + 1}
              />
              <IconButton
                ref={controlRef(id, "up")}
                size="sm"
                label={`Move ${nameOf(id)} up`}
                icon={ChevronUpIcon}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              />
              <IconButton
                ref={controlRef(id, "down")}
                size="sm"
                label={`Move ${nameOf(id)} down`}
                icon={ChevronDownIcon}
                disabled={index === value.length - 1}
                onClick={() => move(index, 1)}
              />
              <IconButton
                ref={controlRef(id, "remove")}
                size="sm"
                label={`Remove ${nameOf(id)}`}
                icon={CloseIcon}
                onClick={() => remove(index)}
              />
            </li>
          ))}
        </ol>
      ) : null}
      {error ? (
        <p role="alert" className="type-body-sm text-danger">
          {error}
        </p>
      ) : null}
      <TitleSearch picked={value} onPick={add} full={value.length >= max} inputRef={searchField} />
      {value.length >= max ? (
        <p className="type-caption text-fg-subtle">
          The list is full ({max}): remove one to add another.
        </p>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
