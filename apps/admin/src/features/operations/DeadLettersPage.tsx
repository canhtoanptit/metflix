/**
 * Jobs that failed their last attempt, newest first, without their payloads (a payload can hold
 * a member's address). Each can be published again once; a job that fails again is a new entry.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeadLetter } from "@webflix/contracts";
import { Button, RefreshIcon } from "@webflix/ui";
import { useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog } from "../../components/ActionDialog.tsx";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import {
  DateTime,
  Identifier,
  PageHeader,
  Section,
  StatusBadge,
} from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";

export function DeadLettersPage() {
  useDocumentTitle("Failed jobs");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const page = useQuery({
    ...queries.deadLetters(cursor),
    placeholderData: (previous) => previous,
  });
  const [replaying, setReplaying] = useState<DeadLetter | null>(null);
  const [open, setOpen] = useState(false);

  const columns: Column<DeadLetter>[] = [
    {
      id: "job",
      header: "Job",
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <code className="font-mono text-xs text-fg">{row.jobType}</code>
          <Identifier value={row.id} label="dead letter ID" truncate />
        </span>
      ),
    },
    { id: "failed", header: "Failed", cell: (row) => <DateTime value={row.failedAt} /> },
    {
      id: "attempts",
      header: "Attempts",
      align: "end",
      hideBelow: "sm",
      cell: (row) => row.attempts,
    },
    {
      id: "error",
      header: "Last error",
      hideBelow: "md",
      className: "max-w-96",
      cell: (row) =>
        row.lastError ? (
          <span className="line-clamp-2 break-words text-fg-muted" title={row.lastError}>
            {row.lastError}
          </span>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      id: "replay",
      header: <span className="sr-only">Replay</span>,
      align: "end",
      cell: (row) =>
        row.replayedAt ? (
          <span className="flex flex-col items-end gap-0.5">
            <StatusBadge tone="outline">Replayed</StatusBadge>
            <span className="type-caption text-fg-subtle">
              <DateTime value={row.replayedAt} />
            </span>
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            icon={RefreshIcon}
            aria-label={`Replay ${row.jobType} ${row.id}`}
            onClick={() => {
              setReplaying(row);
              setOpen(true);
            }}
          >
            Replay
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Failed jobs"
        description="Jobs that failed all five attempts. Fix the cause first (a provider outage, a bad deploy), then replay: each can be replayed once."
      />
      <Section title="Dead letters" description="Newest first. Payloads are not shown.">
        {page.isPending ? (
          <LoadingRows rows={4} label="Loading failed jobs" />
        ) : page.isError ? (
          <ErrorPanel error={page.error} onRetry={() => void page.refetch()} />
        ) : (
          <DataTable
            caption="Failed jobs, newest first"
            columns={columns}
            rows={page.data.items}
            rowKey={(row) => row.id}
            empty={
              <Empty title="No failed jobs" description="Every job finished within its attempts." />
            }
            pager={
              cursors.length > 1 || page.data.nextCursor
                ? {
                    label: `Page ${cursors.length}`,
                    hasPrevious: cursors.length > 1,
                    hasNext: page.data.nextCursor !== null,
                    loading: page.isFetching,
                    onPrevious: () => setCursors((current) => current.slice(0, -1)),
                    onNext: () => {
                      const next = page.data.nextCursor;
                      if (next) setCursors((current) => [...current, next]);
                    },
                  }
                : undefined
            }
          />
        )}
      </Section>
      {replaying ? (
        <ReplayDialog
          key={replaying.id}
          deadLetter={replaying}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

function ReplayDialog({
  deadLetter,
  open,
  onOpenChange,
}: {
  deadLetter: DeadLetter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog<DeadLetter>
      open={open}
      onOpenChange={onOpenChange}
      scope={`replay:${deadLetter.id}`}
      title={`Replay ${deadLetter.jobType}`}
      description="Publishes the job again, once. If the cause isn't fixed it fails again and comes back here as a new entry."
      confirmLabel="Replay job"
      audit={{ targetType: "dead_letter", targetId: deadLetter.id }}
      run={({ reason, signal, headers }) =>
        staffApi().replayDeadLetter(
          { params: { id: deadLetter.id }, body: { reason } },
          { signal, headers },
        )
      }
      onSuccess={() => {
        void queryClient.invalidateQueries({ queryKey: ["staff", "system", "dead-letters"] });
        void queryClient.invalidateQueries({ queryKey: qk.health() });
      }}
      success={(row) => (
        <>
          Published again at <DateTime value={row.replayedAt} seconds />. Its result shows in the
          service's logs; a new entry appears here if it fails again.
        </>
      )}
    />
  );
}
