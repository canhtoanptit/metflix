/**
 * Define an experiment (a draft), or change a draft's design, or a running experiment's end.
 * Validated here as the contract and the experiments service validate it, with plain messages,
 * before anything is sent.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  type EXPERIMENT_AUDIENCES,
  EXPERIMENT_BUCKETS,
  EXPERIMENT_METRICS,
  type ExperimentDefinition,
  PLAN_IDS,
  type PlanId,
} from "@webflix/contracts";
import {
  Button,
  Checkbox,
  ChevronLeftIcon,
  Field,
  IconButton,
  Input,
  PlusIcon,
  RadioGroup,
  RadioItem,
  Select,
  SelectItem,
  Textarea,
  TrashIcon,
} from "@webflix/ui";
import { useId, useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog } from "../../components/ActionDialog.tsx";
import { PageHeader, Section } from "../../components/primitives.tsx";
import { ErrorPanel, LoadingPage } from "../../components/states.tsx";
import { localZoneName } from "../../lib/format.ts";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { planName } from "../../lib/status.ts";
import { localInputToIso } from "../content/AvailabilityPage.tsx";
import { METRIC_LABELS } from "./ExperimentsPage.tsx";

type Metric = (typeof EXPERIMENT_METRICS)[number];
type Audience = (typeof EXPERIMENT_AUDIENCES)[number];

export interface ExperimentDraft {
  key: string;
  name: string;
  description: string;
  unit: "profile" | "device";
  layer: string;
  layerTouched: boolean;
  /** Share of the layer, in percent (0-100, two decimals: one bucket is 0.01%). */
  allocStart: string;
  allocEnd: string;
  percentage: string;
  plans: PlanId[];
  countries: string;
  audience: Audience;
  variants: { name: string; weight: string }[];
  control: string;
  primaryMetric: Metric;
  secondaryMetrics: Metric[];
  alpha: string;
  power: string;
  mde: string;
  srmThreshold: string;
  startsAt: string;
  endsAt: string;
}

export type DraftErrors = Partial<Record<string, string>>;

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const NEW_EXPERIMENT: ExperimentDraft = {
  key: "",
  name: "",
  description: "",
  unit: "profile",
  layer: "",
  layerTouched: false,
  allocStart: "0",
  allocEnd: "100",
  percentage: "100",
  plans: [],
  countries: "",
  audience: "all",
  variants: [
    { name: "control", weight: "1" },
    { name: "treatment", weight: "1" },
  ],
  control: "control",
  primaryMetric: "qualified_plays",
  secondaryMetrics: [],
  alpha: "0.05",
  power: "0.8",
  mde: "0.05",
  srmThreshold: "0.001",
  startsAt: "",
  endsAt: "",
};

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function draftFrom(definition: ExperimentDefinition): ExperimentDraft {
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description ?? "",
    unit: definition.unit,
    layer: definition.layer,
    layerTouched: true,
    allocStart: String(definition.allocation.start / 100),
    allocEnd: String(definition.allocation.end / 100),
    percentage: String(definition.targeting.percentage),
    plans: [...definition.targeting.plans],
    countries: definition.targeting.countries.join(", "),
    audience: definition.targeting.audience,
    variants: definition.variants.map((variant) => ({
      name: variant.name,
      weight: String(variant.weight),
    })),
    control: definition.control,
    primaryMetric: definition.primaryMetric,
    secondaryMetrics: [...definition.secondaryMetrics],
    alpha: String(definition.alpha),
    power: definition.power === null ? "" : String(definition.power),
    mde: String(definition.minimumDetectableEffect),
    srmThreshold: definition.srmThreshold === null ? "" : String(definition.srmThreshold),
    startsAt: toLocalInput(definition.startsAt),
    endsAt: toLocalInput(definition.endsAt),
  };
}

function decimal(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) ? value : null;
}

/** The design as the staff API takes it, and the problems that stop it being sent. */
export function buildDesign(draft: ExperimentDraft): {
  design: Omit<
    ExperimentDefinition,
    | "status"
    | "statusChangeAt"
    | "previousStatus"
    | "salt"
    | "registeredAt"
    | "createdAt"
    | "updatedAt"
  >;
  errors: DraftErrors;
} {
  const errors: DraftErrors = {};
  const key = draft.key.trim();
  if (!KEY.test(key))
    errors.key =
      "Lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit (up to 64).";
  const name = draft.name.trim();
  if (!name) errors.name = "Give it a name people will recognise.";
  else if (name.length > 120) errors.name = "Keep the name to 120 characters.";
  if (draft.description.length > 2000)
    errors.description = "Keep the description to 2000 characters.";
  const layer = (draft.layerTouched ? draft.layer : key.replaceAll(".", "-")).trim();
  if (!KEY.test(layer))
    errors.layer = "Lowercase letters, digits, dots, dashes or underscores (up to 64).";
  const start = decimal(draft.allocStart);
  const end = decimal(draft.allocEnd);
  const startBucket = start === null ? null : Math.round(start * (EXPERIMENT_BUCKETS / 100));
  const endBucket = end === null ? null : Math.round(end * (EXPERIMENT_BUCKETS / 100));
  if (startBucket === null || startBucket < 0 || startBucket > EXPERIMENT_BUCKETS)
    errors.allocStart = "From 0 to 100.";
  if (endBucket === null || endBucket < 0 || endBucket > EXPERIMENT_BUCKETS)
    errors.allocEnd = "From 0 to 100.";
  else if (startBucket !== null && endBucket <= startBucket)
    errors.allocEnd = "Must be above the start.";
  const percentage = decimal(draft.percentage);
  if (percentage === null || percentage < 0 || percentage > 100)
    errors.percentage = "From 0 to 100.";
  const countries = draft.countries
    .split(/[\s,]+/)
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  const badCountry = countries.find((code) => !/^[A-Z]{2}$/.test(code));
  if (badCountry)
    errors.countries = `“${badCountry}” isn't a two-letter country code (ISO 3166-1, like GB).`;
  const variants = draft.variants.map((variant) => ({
    name: variant.name.trim(),
    weight: decimal(variant.weight),
  }));
  if (variants.length < 2) errors.variants = "An experiment needs at least two variants.";
  else if (variants.some((variant) => !variant.name || variant.name.length > 64))
    errors.variants = "Every variant needs a name (up to 64 characters).";
  else if (new Set(variants.map((variant) => variant.name)).size !== variants.length)
    errors.variants = "Variant names must differ.";
  else if (variants.some((variant) => variant.weight === null || variant.weight <= 0))
    errors.variants = "Every weight must be a number above zero.";
  const control = draft.control.trim();
  if (!errors.variants && !variants.some((variant) => variant.name === control))
    errors.control = "Pick the control among the variants.";
  const alpha = decimal(draft.alpha);
  if (alpha === null || alpha <= 0 || alpha > 0.5)
    errors.alpha = "Above 0, at most 0.5 (0.05 is usual).";
  const power = draft.power.trim() === "" ? null : decimal(draft.power);
  if (draft.power.trim() !== "" && (power === null || power <= 0 || power >= 1))
    errors.power = "Between 0 and 1 (0.8 is usual), or empty.";
  const mde = decimal(draft.mde);
  if (mde === null || mde <= 0) errors.mde = "A relative effect above 0 (0.05 is 5%).";
  const srm = draft.srmThreshold.trim() === "" ? null : decimal(draft.srmThreshold);
  if (draft.srmThreshold.trim() !== "" && (srm === null || srm <= 0 || srm > 0.1))
    errors.srmThreshold = "Above 0, at most 0.1 (0.001 is usual), or empty.";
  const startsAt = localInputToIso(draft.startsAt);
  const endsAt = localInputToIso(draft.endsAt);
  if (draft.startsAt && !startsAt) errors.startsAt = "Enter a valid date and time.";
  if (draft.endsAt && !endsAt) errors.endsAt = "Enter a valid date and time.";
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt))
    errors.endsAt = "The end must come after the start.";
  return {
    errors,
    design: {
      key,
      name,
      description: draft.description.trim() ? draft.description.trim() : null,
      unit: draft.unit,
      layer,
      allocation: { start: startBucket ?? 0, end: endBucket ?? 0 },
      targeting: {
        percentage: percentage ?? 0,
        plans: draft.plans,
        countries,
        audience: draft.audience,
      },
      variants: variants.map((variant) => ({ name: variant.name, weight: variant.weight ?? 0 })),
      control,
      primaryMetric: draft.primaryMetric,
      secondaryMetrics: draft.secondaryMetrics.filter((metric) => metric !== draft.primaryMetric),
      alpha: alpha ?? 0,
      power,
      minimumDetectableEffect: mde ?? 0,
      startsAt,
      endsAt,
      srmThreshold: srm,
    },
  };
}

export function NewExperimentPage() {
  useDocumentTitle("New experiment");
  return <ExperimentForm initial={NEW_EXPERIMENT} existing={null} />;
}

const editRoute = getRouteApi("/experiments/$key/edit");

export function EditExperimentPage() {
  useDocumentTitle("Edit experiment");
  const { key } = editRoute.useParams();
  const experiment = useQuery(queries.experiment(key));
  if (experiment.isPending) return <LoadingPage label="Loading the experiment" />;
  if (experiment.isError) {
    return (
      <ErrorPanel
        layout="page"
        error={experiment.error}
        onRetry={() => void experiment.refetch()}
      />
    );
  }
  return (
    <ExperimentForm
      key={experiment.data.updatedAt}
      initial={draftFrom(experiment.data)}
      existing={experiment.data}
    />
  );
}

function ExperimentForm({
  initial,
  existing,
}: {
  initial: ExperimentDraft;
  existing: ExperimentDefinition | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [open, setOpen] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const unitId = useId();
  const controlId = useId();
  const audienceId = useId();
  const endOnly = existing !== null && existing.status !== "draft";
  const { design } = buildDesign(draft);
  const zone = localZoneName();

  function set<K extends keyof ExperimentDraft>(key: K, value: ExperimentDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function check(): boolean {
    const { errors: found } = buildDesign(draft);
    const relevant: DraftErrors = endOnly ? { endsAt: found.endsAt } : found;
    if (
      endOnly &&
      existing?.startsAt &&
      design.endsAt &&
      Date.parse(design.endsAt) <= Date.parse(existing.startsAt)
    ) {
      relevant.endsAt = "The end must come after the start.";
    }
    setErrors(relevant);
    return !Object.values(relevant).some(Boolean);
  }

  const back = existing
    ? { to: "/experiments/$key" as const, params: { key: existing.key }, label: existing.name }
    : { to: "/experiments" as const, params: {}, label: "Experiments" };

  return (
    <>
      <Link
        to={back.to}
        params={back.params}
        className="focus-ring mb-3 inline-flex items-center gap-1 rounded-xs type-body-sm text-fg-muted hover:text-fg"
      >
        <ChevronLeftIcon size="sm" />
        {back.label}
      </Link>
      <PageHeader
        title={
          existing
            ? endOnly
              ? `Change the end of “${existing.name}”`
              : `Edit “${existing.name}”`
            : "New experiment"
        }
        description={
          endOnly
            ? "A started experiment's design is fixed (pre-registered); only its end can move."
            : "Saved as a draft. Nothing reaches members until you start it, and its design is fixed from then on."
        }
      />
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (check()) setOpen(true);
        }}
      >
        <fieldset disabled={endOnly} className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
          <Section title="Basics">
            <div className="flex flex-col gap-4">
              <Field
                label="Key"
                required
                error={errors.key}
                hint="Lowercase, stable: it names the experiment in events and analysis. Can't change later."
              >
                <Input
                  size="sm"
                  value={draft.key}
                  disabled={existing !== null}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="home.billboard-autoplay"
                  onChange={(event) => set("key", event.target.value)}
                />
              </Field>
              <Field label="Name" required error={errors.name}>
                <Input
                  size="sm"
                  value={draft.name}
                  onChange={(event) => set("name", event.target.value)}
                />
              </Field>
              <Field label="Hypothesis and notes" error={errors.description} hint="Optional.">
                <Textarea
                  size="sm"
                  rows={3}
                  value={draft.description}
                  onChange={(event) => set("description", event.target.value)}
                />
              </Field>
            </div>
          </Section>
          <Section title="Who takes part">
            <div className="flex flex-col gap-4">
              <fieldset>
                <legend id={unitId} className="mb-2 type-label text-fg">
                  Unit
                </legend>
                <RadioGroup
                  aria-labelledby={unitId}
                  value={draft.unit}
                  onValueChange={(value) => set("unit", value as ExperimentDraft["unit"])}
                  className="flex flex-col gap-2"
                >
                  <RadioItem
                    value="profile"
                    label="Profiles"
                    description="Each signed-in profile gets one variant."
                  />
                  <RadioItem
                    value="device"
                    label="Devices"
                    description="Before sign-in: each browser gets one variant."
                  />
                </RadioGroup>
              </fieldset>
              <Field
                label="Layer"
                error={errors.layer}
                hint="Experiments in the same layer never share a unit; different layers overlap."
              >
                <Input
                  size="sm"
                  value={draft.layerTouched ? draft.layer : draft.key.replaceAll(".", "-")}
                  placeholder="Follows the key unless you name one"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      layer: event.target.value,
                      layerTouched: true,
                    }))
                  }
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Layer from (%)" error={errors.allocStart}>
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={draft.allocStart}
                    onChange={(event) => set("allocStart", event.target.value)}
                  />
                </Field>
                <Field label="Layer to (%)" error={errors.allocEnd}>
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={draft.allocEnd}
                    onChange={(event) => set("allocEnd", event.target.value)}
                  />
                </Field>
                <Field label="Enrol (%)" error={errors.percentage} hint="Of eligible units.">
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={draft.percentage}
                    onChange={(event) => set("percentage", event.target.value)}
                  />
                </Field>
              </div>
              <fieldset>
                <legend className="mb-2 type-label text-fg">Plans</legend>
                <div className="flex flex-wrap gap-4">
                  {PLAN_IDS.map((plan) => (
                    <Checkbox
                      key={plan}
                      label={planName(plan)}
                      checked={draft.plans.includes(plan)}
                      onCheckedChange={(checked) =>
                        set(
                          "plans",
                          checked
                            ? [...draft.plans, plan]
                            : draft.plans.filter((value) => value !== plan),
                        )
                      }
                    />
                  ))}
                </div>
                <p className="mt-1 type-caption text-fg-subtle">None ticked: every plan.</p>
              </fieldset>
              <Field
                label="Countries"
                error={errors.countries}
                hint="Two-letter codes, comma separated. Empty: every country."
              >
                <Input
                  size="sm"
                  value={draft.countries}
                  placeholder="GB, IE"
                  autoComplete="off"
                  onChange={(event) => set("countries", event.target.value)}
                />
              </Field>
              <fieldset>
                <legend id={audienceId} className="mb-2 type-label text-fg">
                  Members
                </legend>
                <RadioGroup
                  aria-labelledby={audienceId}
                  value={draft.audience}
                  onValueChange={(value) => set("audience", value as Audience)}
                  className="flex flex-wrap gap-x-6 gap-y-2"
                >
                  <RadioItem value="all" label="All" />
                  <RadioItem value="new" label="New" />
                  <RadioItem value="existing" label="Existing" />
                </RadioGroup>
              </fieldset>
            </div>
          </Section>
          <Section title="Variants">
            <div className="flex flex-col gap-3">
              <fieldset>
                <legend id={controlId} className="sr-only">
                  Control variant
                </legend>
                <ul className="flex flex-col gap-2">
                  {draft.variants.map((variant, index) => (
                    <li key={index} className="flex flex-wrap items-end gap-2">
                      <Field label={`Variant ${index + 1} name`} className="min-w-40 flex-1">
                        <Input
                          size="sm"
                          value={variant.name}
                          autoComplete="off"
                          onChange={(event) => {
                            const next = [...draft.variants];
                            const previousName = variant.name;
                            next[index] = { ...variant, name: event.target.value };
                            setDraft((current) => ({
                              ...current,
                              variants: next,
                              control:
                                current.control === previousName
                                  ? event.target.value
                                  : current.control,
                            }));
                            setErrors((current) => ({
                              ...current,
                              variants: undefined,
                              control: undefined,
                            }));
                          }}
                        />
                      </Field>
                      <Field label="Weight" className="w-24">
                        <Input
                          size="sm"
                          inputMode="decimal"
                          value={variant.weight}
                          onChange={(event) => {
                            const next = [...draft.variants];
                            next[index] = { ...variant, weight: event.target.value };
                            set("variants", next);
                          }}
                        />
                      </Field>
                      <label className="flex h-9 items-center gap-2 type-body-sm text-fg-muted">
                        <input
                          type="radio"
                          name={controlId}
                          className="size-4 accent-accent"
                          checked={draft.control === variant.name && variant.name !== ""}
                          onChange={() => set("control", variant.name)}
                        />
                        Control
                      </label>
                      <IconButton
                        size="sm"
                        label={`Remove variant ${variant.name || index + 1}`}
                        icon={TrashIcon}
                        disabled={draft.variants.length <= 2}
                        onClick={() =>
                          set(
                            "variants",
                            draft.variants.filter((_, position) => position !== index),
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              </fieldset>
              {errors.variants ? (
                <p role="alert" className="type-body-sm text-danger">
                  {errors.variants}
                </p>
              ) : null}
              {errors.control ? (
                <p role="alert" className="type-body-sm text-danger">
                  {errors.control}
                </p>
              ) : null}
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  icon={PlusIcon}
                  onClick={() =>
                    set("variants", [
                      ...draft.variants,
                      { name: `variant-${draft.variants.length + 1}`, weight: "1" },
                    ])
                  }
                >
                  Add a variant
                </Button>
              </div>
              <p className="type-caption text-fg-subtle">
                Weights are relative: 1 and 1 split evenly.
              </p>
            </div>
          </Section>
          <Section title="Analysis">
            <div className="flex flex-col gap-4">
              <Field label="Primary metric">
                <Select
                  variant="compact"
                  value={draft.primaryMetric}
                  onValueChange={(value) => set("primaryMetric", value as Metric)}
                >
                  {EXPERIMENT_METRICS.map((metric) => (
                    <SelectItem key={metric} value={metric}>
                      {METRIC_LABELS[metric] ?? metric}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
              <fieldset>
                <legend className="mb-2 type-label text-fg">Secondary metrics</legend>
                <div className="flex flex-wrap gap-4">
                  {EXPERIMENT_METRICS.filter((metric) => metric !== draft.primaryMetric).map(
                    (metric) => (
                      <Checkbox
                        key={metric}
                        label={METRIC_LABELS[metric] ?? metric}
                        checked={draft.secondaryMetrics.includes(metric)}
                        onCheckedChange={(checked) =>
                          set(
                            "secondaryMetrics",
                            checked
                              ? [...draft.secondaryMetrics, metric]
                              : draft.secondaryMetrics.filter((value) => value !== metric),
                          )
                        }
                      />
                    ),
                  )}
                </div>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Significance level (α)" error={errors.alpha}>
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={draft.alpha}
                    onChange={(event) => set("alpha", event.target.value)}
                  />
                </Field>
                <Field label="Power" error={errors.power} hint="Optional.">
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={draft.power}
                    onChange={(event) => set("power", event.target.value)}
                  />
                </Field>
                <Field
                  label="Minimum detectable effect"
                  error={errors.mde}
                  hint="Relative: 0.05 is 5%."
                >
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={draft.mde}
                    onChange={(event) => set("mde", event.target.value)}
                  />
                </Field>
                <Field
                  label="Sample-ratio alarm below"
                  error={errors.srmThreshold}
                  hint="p-value; optional."
                >
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={draft.srmThreshold}
                    onChange={(event) => set("srmThreshold", event.target.value)}
                  />
                </Field>
              </div>
            </div>
          </Section>
        </fieldset>
        <Section
          title="Schedule"
          description={`Your time zone, ${zone}. Empty start: when it is started.`}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start (optional)" error={errors.startsAt}>
              <Input
                size="sm"
                type="datetime-local"
                disabled={endOnly}
                value={draft.startsAt}
                onChange={(event) => set("startsAt", event.target.value)}
              />
            </Field>
            <Field
              label="End (optional)"
              error={errors.endsAt}
              hint="Nobody new is assigned after it."
            >
              <Input
                size="sm"
                type="datetime-local"
                value={draft.endsAt}
                onChange={(event) => set("endsAt", event.target.value)}
              />
            </Field>
          </div>
        </Section>
        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={back.to} params={back.params}>
              Cancel
            </Link>
          </Button>
          <Button type="submit" variant="accent" size="sm">
            {existing ? "Save changes" : "Save draft"}
          </Button>
        </div>
      </form>
      <ActionDialog<ExperimentDefinition>
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && savedKey)
            void navigate({ to: "/experiments/$key", params: { key: savedKey } });
        }}
        scope={`experiment-save:${existing?.key ?? "new"}`}
        title={existing ? `Save “${design.name}”` : `Save “${design.name}” as a draft`}
        description={
          existing
            ? endOnly
              ? "Only the end changes."
              : "The draft's design is replaced."
            : "Nothing reaches members until you start it."
        }
        confirmLabel="Save"
        audit={{ targetType: "experiment", targetId: design.key }}
        run={({ reason, signal, headers }) => {
          if (!existing)
            return staffApi().createExperiment(
              { body: { ...design, reason } },
              { signal, headers },
            );
          const { key: _key, ...changes } = design;
          return staffApi().updateExperiment(
            {
              params: { key: existing.key },
              body: endOnly ? { endsAt: design.endsAt, reason } : { ...changes, reason },
            },
            { signal, headers },
          );
        }}
        onSuccess={(saved) => {
          queryClient.setQueryData(qk.experiment(saved.key), saved);
          void queryClient.invalidateQueries({ queryKey: qk.experiments(), exact: true });
          setSavedKey(saved.key);
        }}
        success={(saved) =>
          existing
            ? `“${saved.name}” is saved.`
            : `“${saved.name}” is saved as a draft. Start it from its page when you're ready.`
        }
      />
    </>
  );
}
