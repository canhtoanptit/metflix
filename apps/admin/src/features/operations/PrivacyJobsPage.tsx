/**
 * The operator's side of members' privacy requests, for whoever runs the pipeline's jobs by hand:
 * the pseudonymous keys the lake's next compaction must erase (confirm once it ran with
 * `--erase`), and the data exports whose events `export-events` must extract (record its results
 * document). Keys are pseudonyms, never a member's identity; no download link appears here.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExportResultsBody } from "@webflix/contracts";
import { Button, Checkbox, FieldMessage, Label } from "@webflix/ui";
import { useId, useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog, SHOWN_IN_FIELD } from "../../components/ActionDialog.tsx";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import { DateTime, PageHeader, Section } from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";

const MAX_CONFIRM = 200;

export function PrivacyJobsPage() {
  useDocumentTitle("Privacy jobs");
  return (
    <>
      <PageHeader
        title="Privacy jobs"
        description="For operators who run the pipeline's compaction and export jobs by hand. On Kubernetes and Cloudflare the scheduled jobs do this themselves."
      />
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <ErasuresSection />
        <ExportsSection />
      </div>
    </>
  );
}

function ErasuresSection() {
  const erasures = useQuery(queries.erasures());
  const [open, setOpen] = useState(false);
  const keys = erasures.data?.subjectKeys ?? [];
  return (
    <Section
      title="Pending erasures"
      description="Pseudonymous keys whose events the next compaction must drop (compact --erase)."
      actions={
        keys.length > 0 ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Confirm erased
          </Button>
        ) : null
      }
    >
      {erasures.isPending ? (
        <LoadingRows rows={3} label="Loading pending erasures" />
      ) : erasures.isError ? (
        <ErrorPanel error={erasures.error} onRetry={() => void erasures.refetch()} />
      ) : keys.length === 0 ? (
        <Empty
          title="Nothing to erase"
          description="Every deleted account's events are gone from the lake."
        />
      ) : (
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {keys.map((key) => (
            <li key={key}>
              <code className="font-mono text-xs text-fg-muted">{key}</code>
            </li>
          ))}
        </ul>
      )}
      {keys.length > 0 ? (
        <ConfirmErasuresDialog keys={keys} open={open} onOpenChange={setOpen} />
      ) : null}
    </Section>
  );
}

function ConfirmErasuresDialog({
  keys,
  open,
  onOpenChange,
}: {
  keys: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>(() => keys.slice(0, MAX_CONFIRM));
  const listId = useId();
  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      scope="erasures-confirm"
      title="Confirm the compaction erased these keys"
      description="Only after a compaction ran with --erase on exactly these keys: confirming takes them off this list for good."
      confirmLabel={`Confirm ${selected.length} erased`}
      size="lg"
      audit={{ targetType: "event_lake", targetId: "erasures" }}
      validate={() => (selected.length === 0 ? "Tick at least one key." : null)}
      run={({ reason, signal, headers }) =>
        staffApi().confirmErasures({ body: { subjectKeys: selected, reason } }, { signal, headers })
      }
      onSuccess={() => void queryClient.invalidateQueries({ queryKey: qk.erasures() })}
      success={() =>
        `${selected.length} ${selected.length === 1 ? "key is" : "keys are"} recorded as erased.`
      }
    >
      <fieldset>
        <legend id={listId} className="mb-2 type-label text-fg">
          Keys ({selected.length} of {Math.min(keys.length, MAX_CONFIRM)} ticked; at most{" "}
          {MAX_CONFIRM} at a time)
        </legend>
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md border border-line-subtle p-3">
          {keys.slice(0, MAX_CONFIRM).map((key) => (
            <Checkbox
              key={key}
              checked={selected.includes(key)}
              onCheckedChange={(checked) =>
                setSelected((current) =>
                  checked ? [...current, key] : current.filter((value) => value !== key),
                )
              }
              label={<code className="font-mono text-xs">{key}</code>}
            />
          ))}
        </div>
      </fieldset>
    </ActionDialog>
  );
}

type PendingExport = { requestId: string; accountKey: string; from: string; to: string };

function ExportsSection() {
  const exports = useQuery(queries.exports());
  const [open, setOpen] = useState(false);
  const columns: Column<PendingExport>[] = [
    {
      id: "request",
      header: "Request",
      cell: (row) => <code className="font-mono text-xs">{row.requestId}</code>,
    },
    {
      id: "key",
      header: "Account key",
      hideBelow: "md",
      cell: (row) => <code className="font-mono text-xs text-fg-muted">{row.accountKey}</code>,
    },
    {
      id: "window",
      header: "Events received",
      cell: (row) => (
        <span className="type-caption">
          <DateTime value={row.from} /> to <DateTime value={row.to} />
        </span>
      ),
    },
  ];
  return (
    <Section
      title="Pending exports"
      description="Data exports waiting for their events (export-events)."
      actions={
        (exports.data?.requests.length ?? 0) > 0 ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Record results
          </Button>
        ) : null
      }
    >
      {exports.isPending ? (
        <LoadingRows rows={3} label="Loading pending exports" />
      ) : exports.isError ? (
        <ErrorPanel error={exports.error} onRetry={() => void exports.refetch()} />
      ) : (
        <DataTable
          caption="Pending exports"
          columns={columns}
          rows={exports.data.requests}
          rowKey={(row) => row.requestId}
          pageSize={25}
          empty={
            <Empty
              title="No exports waiting"
              description="Every requested export has its events."
            />
          }
        />
      )}
      <RecordResultsDialog open={open} onOpenChange={setOpen} />
    </Section>
  );
}

/** The job's results document, checked against the contract before it is sent. */
export function readResults(text: string): {
  document: Omit<ExportResultsBody, "reason"> | null;
  error: string | null;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      document: null,
      error: "That file isn't JSON. Choose the results document export-events wrote.",
    };
  }
  const parsed = ExportResultsBody.safeParse({ ...(raw as object), reason: "check" });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      document: null,
      error: `That isn't an export-events results document${issue ? ` (${issue.path.join(".") || "document"}: ${issue.message})` : ""}.`,
    };
  }
  const { reason: _reason, ...document } = parsed.data;
  return { document, error: null };
}

function RecordResultsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [document, setDocument] = useState<Omit<ExportResultsBody, "reason"> | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileId = useId();
  const counts = document
    ? document.results.reduce<Record<string, number>>((all, result) => {
        all[result.status] = (all[result.status] ?? 0) + 1;
        return all;
      }, {})
    : null;
  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      scope="exports-results"
      title="Record export-events results"
      description="Complete results are read, checked against their size and hash, and folded into the members' exports; the rest stay listed."
      confirmLabel="Record results"
      audit={{ targetType: "event_lake", targetId: "exports" }}
      validate={() =>
        document ? null : fileError ? SHOWN_IN_FIELD : "Choose the results document first."
      }
      run={({ reason, signal, headers }) => {
        if (!document) throw new Error("No document");
        return staffApi().recordExportResults(
          { body: { ...document, reason } },
          { signal, headers },
        );
      }}
      onSuccess={() => void queryClient.invalidateQueries({ queryKey: qk.exports() })}
      success={() => "Recorded. Completed exports are on their way to the members by email."}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fileId}>Results document (JSON)</Label>
        <input
          id={fileId}
          type="file"
          accept="application/json,.json"
          aria-describedby={`${fileId}-message`}
          aria-invalid={fileError ? true : undefined}
          className="focus-ring rounded-control type-body-sm text-fg-muted file:me-3 file:rounded-control file:border file:border-line-strong file:bg-surface-3 file:px-3 file:py-1.5 file:text-fg"
          onChange={(event) => {
            const file = event.target.files?.[0];
            setDocument(null);
            setFileError(null);
            if (!file) return;
            if (file.size > 1_000_000) {
              setFileError("That file is larger than a results document can be.");
              return;
            }
            void file.text().then((text) => {
              const result = readResults(text);
              setDocument(result.document);
              setFileError(result.error);
            });
          }}
        />
        <FieldMessage id={`${fileId}-message`} tone={fileError ? "error" : "hint"}>
          {fileError ?? "The webflix.export-events-results file the job wrote."}
        </FieldMessage>
      </div>
      {counts ? (
        <p className="type-body-sm text-fg">
          {document?.results.length} results:{" "}
          {Object.entries(counts)
            .map(([status, count]) => `${count} ${status}`)
            .join(", ")}
          .
        </p>
      ) : null}
    </ActionDialog>
  );
}
