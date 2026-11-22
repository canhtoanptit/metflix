/**
 * Make a title available or not, optionally only within a window (a licence period). Pick the
 * title by name, see its current override, change it; the list beside it is every title with an
 * override, and whether it is off the service right now.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { StaffTitle, TitleAvailability, TitleAvailabilityOverride } from "@webflix/contracts";
import { Button, EditIcon, Field, Input, RadioGroup, RadioItem } from "@webflix/ui";
import { useEffect, useId, useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog } from "../../components/ActionDialog.tsx";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import { DateTime, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { localZoneName } from "../../lib/format.ts";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { TitleRow, useTitles } from "./TitleListEditor.tsx";
import { TitleSearch } from "./TitleSearch.tsx";

/** `datetime-local` value (the browser's zone) to ISO UTC; null for empty or invalid. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** ISO to a `datetime-local` value in the browser's zone. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What an override means now, in words. */
export function availabilityLine(state: TitleAvailability, now: number): string {
  if (!state.available) return "Off the service";
  const from = state.availableFrom ? Date.parse(state.availableFrom) : null;
  const until = state.availableUntil ? Date.parse(state.availableUntil) : null;
  if (from !== null && from > now) return "Not yet available: its window hasn't started";
  if (until !== null && until <= now) return "No longer available: its window has ended";
  if (from === null && until === null)
    return state.updatedAt ? "Available (override, no window)" : "Available (no override)";
  return "Available within its window";
}

type Errors = Partial<Record<"from" | "until", string>>;

export function AvailabilityPage() {
  useDocumentTitle("Availability");
  const [chosen, setChosen] = useState<string | null>(null);
  const [known, setKnown] = useState<StaffTitle | null>(null);
  return (
    <>
      <PageHeader
        title="Availability"
        description="Take a title off the service, or limit it to a window. Members can't open or play a title outside its availability, and it leaves every row."
      />
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Choose a title">
            <TitleSearch
              picked={chosen ? [chosen] : []}
              actionLabel="Choose"
              pickedLabel="Chosen"
              onPick={(title) => {
                setKnown(title);
                setChosen(title.id);
              }}
            />
          </Section>
          {chosen ? (
            <ChangeAvailability
              key={chosen}
              titleId={chosen}
              known={known?.id === chosen ? known : undefined}
            />
          ) : null}
        </div>
        <OverridesSection
          onChoose={(titleId) => {
            setKnown(null);
            setChosen(titleId);
          }}
        />
      </div>
    </>
  );
}

function ChangeAvailability({
  titleId,
  known,
}: {
  titleId: string;
  known: StaffTitle | undefined;
}) {
  const queryClient = useQueryClient();
  const current = useQuery(queries.titleAvailability(titleId));
  const titles = useTitles([titleId]);
  const title = titles.byId.get(titleId) ?? known;
  const name = title?.name ?? titleId;
  const [available, setAvailable] = useState<"yes" | "no">("no");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [open, setOpen] = useState(false);
  const availableId = useId();
  const zone = localZoneName();

  // The form starts from the title's current override.
  useEffect(() => {
    if (!current.data) return;
    setAvailable(current.data.available ? "yes" : "no");
    setFrom(isoToLocalInput(current.data.availableFrom));
    setUntil(isoToLocalInput(current.data.availableUntil));
  }, [current.data]);

  const fromIso = localInputToIso(from);
  const untilIso = localInputToIso(until);

  function validate(): Errors {
    const found: Errors = {};
    if (from && !fromIso) found.from = "Enter a valid date and time.";
    if (until && !untilIso) found.until = "Enter a valid date and time.";
    if (fromIso && untilIso && Date.parse(untilIso) <= Date.parse(fromIso)) {
      found.until = "The end must come after the start.";
    }
    return found;
  }

  return (
    <Section title="Change its availability">
      <div className="mb-4 flex items-center rounded-md bg-surface-2 px-2 py-1.5">
        <TitleRow id={titleId} title={title} loading={titles.loading} />
      </div>
      {current.isPending ? (
        <LoadingRows rows={2} label="Loading its availability" />
      ) : current.isError ? (
        <ErrorPanel error={current.error} onRetry={() => void current.refetch()} />
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const found = validate();
            setErrors(found);
            if (!Object.values(found).some(Boolean)) setOpen(true);
          }}
        >
          <p className="type-body-sm text-fg">
            Now: {availabilityLine(current.data, Date.now())}
            {current.data.updatedAt ? (
              <span className="text-fg-subtle">
                {" "}
                · changed <DateTime value={current.data.updatedAt} />
              </span>
            ) : null}
          </p>
          <fieldset>
            <legend id={availableId} className="mb-2 type-label text-fg">
              Available to members
            </legend>
            <RadioGroup
              aria-labelledby={availableId}
              value={available}
              onValueChange={(value) => setAvailable(value as "yes" | "no")}
              className="flex flex-col gap-2"
            >
              <RadioItem
                value="yes"
                label="Available"
                description="Within the window below, if you set one."
              />
              <RadioItem
                value="no"
                label="Not available"
                description="Off the service until made available again."
              />
            </RadioGroup>
          </fieldset>
          {available === "yes" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From (optional)" error={errors.from} hint={`Your time zone, ${zone}.`}>
                <Input
                  size="sm"
                  type="datetime-local"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                    setErrors((current) => ({ ...current, from: undefined }));
                  }}
                />
              </Field>
              <Field label="Until (optional)" error={errors.until} hint="Empty: no end.">
                <Input
                  size="sm"
                  type="datetime-local"
                  value={until}
                  onChange={(event) => {
                    setUntil(event.target.value);
                    setErrors((current) => ({ ...current, until: undefined }));
                  }}
                />
              </Field>
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" variant="accent" size="sm">
              Review the change
            </Button>
          </div>
        </form>
      )}
      <ActionDialog<TitleAvailability>
        open={open}
        onOpenChange={setOpen}
        scope={`availability:${titleId}`}
        title={available === "yes" ? `Make “${name}” available` : `Take “${name}” off the service`}
        description={
          available === "no"
            ? "Members can't open or play it, and it leaves every row within a few minutes."
            : fromIso || untilIso
              ? "Members can open and play it only within the window you set."
              : "Members can open and play it from now on."
        }
        confirmLabel={available === "yes" ? "Make available" : "Make unavailable"}
        tone={available === "no" ? "danger" : "accent"}
        audit={{ targetType: "title", targetId: titleId }}
        run={({ reason, signal, headers }) =>
          staffApi().setTitleAvailability(
            {
              params: { titleId },
              body: {
                available: available === "yes",
                availableFrom: available === "yes" ? fromIso : null,
                availableUntil: available === "yes" ? untilIso : null,
                reason,
              },
            },
            { signal, headers },
          )
        }
        onSuccess={(saved) => {
          queryClient.setQueryData(qk.titleAvailability(titleId), saved);
          void queryClient.invalidateQueries({ queryKey: qk.availabilityOverrides() });
        }}
        success={(saved) => `“${name}”: ${availabilityLine(saved, Date.now()).toLowerCase()}.`}
      />
    </Section>
  );
}

function OverridesSection({ onChoose }: { onChoose: (titleId: string) => void }) {
  const overrides = useQuery(queries.availabilityOverrides());
  const columns: Column<TitleAvailabilityOverride>[] = [
    {
      id: "title",
      header: "Title",
      sortValue: (row) => (row.name ?? row.titleId).toLowerCase(),
      cell: (row) => (
        <span className="flex flex-col">
          <span className="font-semibold text-fg">{row.name ?? row.titleId}</span>
          {row.name ? null : (
            <span className="type-caption text-warning">No longer in the catalogue</span>
          )}
        </span>
      ),
    },
    {
      id: "now",
      header: "Now",
      sortValue: (row) => (row.unavailableNow ? 0 : 1),
      cell: (row) => (
        <StatusBadge tone={row.unavailableNow ? "danger" : "positive"}>
          {row.unavailableNow ? "Unavailable" : "Available"}
        </StatusBadge>
      ),
    },
    {
      id: "window",
      header: "Window",
      hideBelow: "md",
      cell: (row) =>
        row.available && (row.availableFrom || row.availableUntil) ? (
          <span className="type-caption">
            <DateTime value={row.availableFrom} fallback="Any time" /> –{" "}
            <DateTime value={row.availableUntil} fallback="no end" />
          </span>
        ) : (
          <span className="text-fg-subtle">{row.available ? "No window" : "Off"}</span>
        ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (row) => (
        <Button
          size="sm"
          variant="ghost"
          icon={EditIcon}
          aria-label={`Change ${row.name ?? row.titleId}`}
          onClick={() => onChoose(row.titleId)}
        >
          Change
        </Button>
      ),
    },
  ];
  return (
    <Section
      title="Titles with an override"
      description="Every title whose availability staff have set."
    >
      {overrides.isPending ? (
        <LoadingRows rows={3} label="Loading overrides" />
      ) : overrides.isError ? (
        <ErrorPanel error={overrides.error} onRetry={() => void overrides.refetch()} />
      ) : (
        <DataTable
          caption="Titles with an availability override"
          columns={columns}
          rows={overrides.data.items}
          rowKey={(row) => row.titleId}
          initialSort={{ column: "now", direction: "asc" }}
          pageSize={25}
          empty={
            <Empty
              title="No overrides"
              description="Every title follows the catalogue's own availability."
            />
          }
        />
      )}
    </Section>
  );
}
