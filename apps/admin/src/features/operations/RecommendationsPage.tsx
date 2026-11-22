/**
 * The recommendation model being served and the last import, with "import now" and "roll back"
 * (serve the previous run again). Members get the change within the model cache's lifetime.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecommendationImportAnswer, RecommendationStatus } from "@webflix/contracts";
import { AlertTriangleIcon, Button, RefreshIcon } from "@webflix/ui";
import { useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog } from "../../components/ActionDialog.tsx";
import {
  DateTime,
  KeyValueList,
  PageHeader,
  Section,
  StatusBadge,
} from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle, useNow } from "../../lib/hooks.ts";

export function RecommendationsPage() {
  useDocumentTitle("Recommendations");
  const status = useQuery(queries.recommendations());
  const [importOpen, setImportOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const now = useNow(60_000);
  const model = status.data?.activeModel ?? null;
  const expired = model ? Date.parse(model.expiresAt) <= now : false;
  return (
    <>
      <PageHeader
        title="Recommendations"
        description="The learned model members' home pages are ranked with. Where it has no fresh list for a profile, the rule engine ranks instead: that's cold start, not an error."
        actions={
          <>
            {model ? (
              <Button variant="outline" size="sm" onClick={() => setRollbackOpen(true)}>
                Roll back
              </Button>
            ) : null}
            <Button
              variant="accent"
              size="sm"
              icon={RefreshIcon}
              onClick={() => setImportOpen(true)}
            >
              Import now
            </Button>
          </>
        }
      />
      {status.isPending ? (
        <LoadingRows rows={4} label="Loading" />
      ) : status.isError ? (
        <ErrorPanel error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <Section title="Served now">
            {model ? (
              <>
                <KeyValueList
                  items={[
                    { label: "Run", value: <code className="font-mono text-sm">{model.run}</code> },
                    { label: "Data as of", value: <DateTime value={model.asOf} /> },
                    { label: "Imported", value: <DateTime value={model.importedAt} /> },
                    {
                      label: "Fresh until",
                      value: (
                        <span className="flex flex-wrap items-center gap-2">
                          <DateTime value={model.expiresAt} />
                          {expired ? <StatusBadge tone="warning">Expired</StatusBadge> : null}
                        </span>
                      ),
                    },
                  ]}
                />
                {expired ? (
                  <p className="mt-4 flex items-start gap-2 type-body-sm text-fg-muted">
                    <AlertTriangleIcon size="sm" className="mt-0.5 shrink-0 text-warning" />
                    Past its freshness: every profile gets the rule engine until a newer run is
                    imported.
                  </p>
                ) : null}
              </>
            ) : (
              <Empty
                title="No model served"
                description="Every profile is ranked by the rule engine. Import a published run to serve learned recommendations."
              />
            )}
          </Section>
          <Section title="Last import">
            <LastImport status={status.data} />
          </Section>
        </div>
      )}
      <ImportAction open={importOpen} onOpenChange={setImportOpen} />
      <RollbackAction open={rollbackOpen} onOpenChange={setRollbackOpen} />
    </>
  );
}

function LastImport({ status }: { status: RecommendationStatus }) {
  const last = status.lastImport;
  if (!last) return <p className="type-body-sm text-fg-subtle">No import has run yet.</p>;
  return (
    <KeyValueList
      items={[
        { label: "Run", value: <code className="font-mono text-sm">{last.run}</code> },
        {
          label: "Result",
          value: (
            <StatusBadge
              tone={
                last.status === "succeeded"
                  ? "positive"
                  : last.status === "failed"
                    ? "danger"
                    : "warning"
              }
            >
              {last.status === "running"
                ? "Running"
                : last.status === "succeeded"
                  ? "Succeeded"
                  : "Failed"}
            </StatusBadge>
          ),
        },
        { label: "Started", value: <DateTime value={last.startedAt} /> },
        { label: "Finished", value: <DateTime value={last.finishedAt} fallback="Not yet" /> },
        ...(last.error
          ? [{ label: "Error", value: <span className="text-danger">{last.error}</span> }]
          : []),
      ]}
    />
  );
}

/** What an import request found, in words (`RecommendationImportAnswer.outcome`). */
export function importOutcomeText(answer: RecommendationImportAnswer): string {
  switch (answer.outcome) {
    case "queued":
      return `Run ${answer.run ?? "(unnamed)"} is being imported. Members get it within a few minutes of the import finishing; Last import shows how it went.`;
    case "nothing_published":
      return "Nothing to import: the pipeline hasn't published a run yet. Nothing changed.";
    case "already_served":
      return `Run ${answer.run ?? "(unnamed)"} is already the one being served. Nothing changed.`;
    case "invalid":
      return `The published run${answer.run ? ` ${answer.run}` : ""} can't be imported: ${answer.detail ?? "its files don't check out"}. Nothing changed; the pipeline must publish a good run.`;
    case "no_artefact_store":
      return "This deployment has no store for the pipeline's runs, so there is nothing to import from. Nothing changed.";
  }
}

function ImportAction({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog<RecommendationImportAnswer>
      open={open}
      onOpenChange={onOpenChange}
      scope="recommendations:import"
      title="Import the latest published run"
      description="Imports the run the pipeline last published, if it is new. Members get it within a few minutes of the import finishing."
      confirmLabel="Import"
      audit={{ targetType: "recommendations", targetId: "served" }}
      run={({ reason, signal, headers }) =>
        staffApi().importRecommendations({ body: { reason } }, { signal, headers })
      }
      onSuccess={({ outcome: _outcome, run: _run, detail: _detail, ...status }) =>
        queryClient.setQueryData(qk.recommendations(), status)
      }
      success={importOutcomeText}
    />
  );
}

function RollbackAction({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog<RecommendationStatus>
      open={open}
      onOpenChange={onOpenChange}
      scope="recommendations:rollback"
      title="Roll back to the previous run"
      description="Serves the run before the current one again, for every member within a few minutes. Use it when a new run made things worse."
      confirmLabel="Roll back"
      tone="danger"
      audit={{ targetType: "recommendations", targetId: "served" }}
      run={({ reason, signal, headers }) =>
        staffApi().rollbackRecommendations({ body: { reason } }, { signal, headers })
      }
      onSuccess={(next) => queryClient.setQueryData(qk.recommendations(), next)}
      success={(next) => `Now serving run ${next.activeModel?.run ?? "none"}.`}
    />
  );
}
