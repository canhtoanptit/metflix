/**
 * Find a title by name (the staff API's `GET /titles`: every maturity level, unavailable titles
 * included) and pick it. Results follow the typing after a short pause; with nothing typed the
 * catalogue is listed by name. A plain list of buttons rather than a combobox: every result is
 * reachable with Tab, says what it is, and the count is announced. A picked title's button stays
 * where it is, focusable and marked unavailable (`aria-disabled`, not `disabled`), so focus stays
 * on it after Add and the next Tab reaches the next result (UX review 2.7).
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { StaffTitle } from "@webflix/contracts";
import { Button, CheckIcon, Field, Input, PlusIcon, ResponsiveImage } from "@webflix/ui";
import { type Ref, useEffect, useState } from "react";
import { queries } from "../../api/queries.ts";
import { ErrorPanel, LoadingRows } from "../../components/states.tsx";

const MATURITY: Record<string, string> = { ALL: "All ages" };

export function titleLine(title: Pick<StaffTitle, "releaseYear" | "type" | "maturity">): string {
  return `${title.releaseYear} · ${title.type === "movie" ? "Film" : "Series"} · ${MATURITY[title.maturity] ?? title.maturity}`;
}

export function TitleThumb({ title }: { title: Pick<StaffTitle, "card" | "name"> }) {
  return (
    <span className="relative block aspect-video w-16 shrink-0 overflow-hidden rounded-xs bg-surface-3">
      <ResponsiveImage image={title.card} alt="" sizes="64px" fill placeholder="color" />
    </span>
  );
}

export function TitleSearch({
  label = "Find a title",
  picked,
  onPick,
  actionLabel = "Add",
  pickedLabel = "Added",
  full = false,
  inputRef,
}: {
  label?: string;
  /** Ids already chosen (shown as added, not offered again). */
  picked: readonly string[];
  onPick: (title: StaffTitle) => void;
  actionLabel?: string;
  /** What a picked title's button says ("Added", "Chosen"). */
  pickedLabel?: string;
  /** No more can be added (the list is full). */
  full?: boolean;
  /** The search field, for a caller that moves focus back to it. */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useQuery({ ...queries.titleSearch(query), placeholderData: keepPreviousData });
  const items = results.data?.items ?? [];

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint="By name, as members search. Unavailable titles are listed too.">
        <Input
          ref={inputRef}
          size="sm"
          type="search"
          value={text}
          placeholder="Title name"
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter in this field searches; it never submits the surrounding form.
            if (event.key === "Enter") {
              event.preventDefault();
              setQuery(text.trim());
            }
          }}
        />
      </Field>
      <p aria-live="polite" className="sr-only">
        {results.isFetching
          ? ""
          : items.length === 0
            ? "No title matches."
            : `${items.length} ${items.length === 1 ? "title" : "titles"} listed.`}
      </p>
      {results.isPending ? (
        <LoadingRows rows={3} label="Finding titles" />
      ) : results.isError ? (
        <ErrorPanel error={results.error} onRetry={() => void results.refetch()} />
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-subtle px-3 py-4 text-center type-body-sm text-fg-muted">
          No title matches “{query}”. Try fewer letters, or another word of the name.
        </p>
      ) : (
        <ul
          aria-label={query ? `Titles matching “${query}”` : "Titles by name"}
          className="flex max-h-72 flex-col divide-y divide-line-subtle overflow-y-auto rounded-md border border-line-subtle"
        >
          {items.map((title) => {
            const added = picked.includes(title.id);
            const unavailable = added || full;
            return (
              <li key={title.id} className="flex items-center gap-3 px-2 py-1.5">
                <TitleThumb title={title} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate type-body-sm font-semibold text-fg">{title.name}</span>
                  <span className="type-caption text-fg-subtle">{titleLine(title)}</span>
                </span>
                <Button
                  size="sm"
                  variant={added ? "ghost" : "outline"}
                  icon={added ? CheckIcon : PlusIcon}
                  aria-disabled={unavailable || undefined}
                  aria-label={
                    added ? `${pickedLabel} ${title.name}` : `${actionLabel} ${title.name}`
                  }
                  onClick={() => {
                    if (!unavailable) onPick(title);
                  }}
                >
                  {added ? pickedLabel : actionLabel}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
