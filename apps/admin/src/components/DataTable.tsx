/**
 * A dense table: sortable columns (for complete lists), client-side pages for long ones, and a
 * caption that names it. It scrolls sideways inside its own focusable region on narrow screens,
 * so the page never does. Server-paged lists (members, audit) pass `pager` instead and keep the
 * server's order, which the caption states.
 */
import {
  Button,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  cx,
} from "@webflix/ui";
import { type ReactNode, useId, useMemo, useState } from "react";

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable (complete lists only). */
  sortValue?: (row: T) => string | number | null;
  align?: "start" | "end";
  /** Hide on narrow screens (secondary detail). */
  hideBelow?: "sm" | "md" | "lg";
  className?: string;
}

export interface ServerPager {
  /** "Page 2", or "Newest first" etc. */
  label: ReactNode;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  loading?: boolean;
}

interface DataTableProps<T> {
  caption: string;
  /** Show the caption (default: for screen readers only, when a section heading names it). */
  showCaption?: boolean;
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  /** Client-side page size for long, complete lists. */
  pageSize?: number;
  initialSort?: { column: string; direction: "asc" | "desc" };
  pager?: ServerPager;
  /** Highlight a row (e.g. the audit entry a link pointed at). */
  highlight?: (row: T) => boolean;
  /** Extra content under a row (expanded details), rendered as a full-width row. */
  expanded?: (row: T) => ReactNode | null;
}

const HIDE: Record<NonNullable<Column<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

export function DataTable<T>({
  caption,
  showCaption = false,
  columns,
  rows,
  rowKey,
  empty,
  pageSize,
  initialSort,
  pager,
  highlight,
  expanded,
}: DataTableProps<T>) {
  const captionId = useId();
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((candidate) => candidate.id === sort.column);
    if (!column?.sortValue) return rows;
    const value = column.sortValue;
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (left === right) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return (left < right ? -1 : 1) * factor;
    });
  }, [rows, columns, sort]);

  const pages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(page, pages - 1);
  const visible = pageSize ? sorted.slice(current * pageSize, (current + 1) * pageSize) : sorted;

  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div className="flex flex-col gap-3">
      {showCaption ? (
        // Shown outside the scrolling area so it never scrolls away; the table's own caption
        // (for assistive technology) says the same.
        <p aria-hidden className="type-caption text-fg-subtle">
          {caption}
        </p>
      ) : null}
      <section
        aria-labelledby={captionId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls sideways must be reachable by keyboard (WCAG 2.1.1).
        tabIndex={0}
        className="focus-ring relative overflow-x-auto rounded-md border border-line-subtle"
      >
        <table className="w-full border-collapse text-start type-body-sm">
          <caption id={captionId} className="sr-only">
            {caption}
          </caption>
          <thead className="bg-surface-2">
            <tr>
              {columns.map((column) => {
                const active = sort?.column === column.id;
                const ariaSort = active
                  ? sort.direction === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={column.sortValue ? (ariaSort ?? "none") : undefined}
                    className={cx(
                      "whitespace-nowrap border-b border-line-subtle px-3 py-2 type-caption text-fg-muted",
                      column.align === "end" ? "text-end" : "text-start",
                      column.hideBelow && HIDE[column.hideBelow],
                    )}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        className={cx(
                          "focus-ring-inset -mx-1 inline-flex items-center gap-1 rounded-xs px-1 hover:text-fg",
                          active && "text-fg",
                        )}
                        onClick={() => {
                          setPage(0);
                          setSort(
                            active && sort.direction === "asc"
                              ? { column: column.id, direction: "desc" }
                              : { column: column.id, direction: "asc" },
                          );
                        }}
                      >
                        {column.header}
                        {active ? (
                          sort.direction === "asc" ? (
                            <ChevronUpIcon size="xs" />
                          ) : (
                            <ChevronDownIcon size="xs" />
                          )
                        ) : null}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const extra = expanded?.(row) ?? null;
              const marked = highlight?.(row) ?? false;
              return (
                <RowGroup key={rowKey(row)}>
                  <tr
                    data-highlighted={marked || undefined}
                    className={cx(
                      "border-b border-line-subtle last:border-b-0 hover:bg-surface-2/60",
                      marked && "bg-accent-subtle hover:bg-accent-subtle",
                    )}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cx(
                          "px-3 py-2 align-top text-fg",
                          column.align === "end" ? "text-end" : "text-start",
                          column.hideBelow && HIDE[column.hideBelow],
                          column.className,
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                  {extra ? (
                    <tr className="border-b border-line-subtle bg-surface-2/40">
                      <td colSpan={columns.length} className="px-3 py-3">
                        {extra}
                      </td>
                    </tr>
                  ) : null}
                </RowGroup>
              );
            })}
          </tbody>
        </table>
      </section>
      {pageSize && pages > 1 ? (
        <Pager
          label={`${current * pageSize + 1}–${Math.min(sorted.length, (current + 1) * pageSize)} of ${sorted.length}`}
          hasPrevious={current > 0}
          hasNext={current < pages - 1}
          onPrevious={() => setPage(current - 1)}
          onNext={() => setPage(current + 1)}
        />
      ) : null}
      {pager ? <Pager {...pager} /> : null}
    </div>
  );
}

function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Pager({ label, hasPrevious, hasNext, onPrevious, onNext, loading }: ServerPager) {
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3">
      <span className="type-caption text-fg-subtle" aria-live="polite">
        {label}
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          icon={ChevronLeftIcon}
          disabled={!hasPrevious || loading}
          onClick={onPrevious}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          iconAfter={ChevronRightIcon}
          disabled={!hasNext || loading}
          loading={loading && hasNext}
          onClick={onNext}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
