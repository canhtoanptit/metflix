/**
 * Where an experiment stands for members right now, which is not always its `status`. A status
 * change takes effect at one instant on every server (`statusChangeAt`, up to a minute after the
 * change was made); until then units are assigned as under `previousStatus`. A running
 * experiment also only assigns inside its `startsAt`/`endsAt` window. The console says "starts
 * at 14:32:05" and "live", never pretends a change is instant.
 */
import type { ExperimentDefinition } from "@webflix/contracts";
import type { BadgeTone } from "@webflix/ui";

type Status = ExperimentDefinition["status"];

export interface Phase {
  /** Short label for a badge: "Live", "Starting", "Paused"… */
  label: string;
  tone: BadgeTone;
  /** A sentence for the detail line (null when the label says it all). */
  detail: string | null;
  /** The instant something changes next for members (ISO), for a countdown. */
  changesAt: string | null;
  /** What happens then, before the time ("Starts at"); null when nothing is scheduled. */
  changeLabel: string | null;
  /** The status that assignment follows right now. */
  effective: Status;
}

export function effectiveStatus(definition: ExperimentDefinition, now: number): Status {
  if (
    definition.statusChangeAt !== null &&
    definition.previousStatus !== null &&
    now < Date.parse(definition.statusChangeAt)
  ) {
    return definition.previousStatus;
  }
  return definition.status;
}

const VERB: Partial<Record<`${Status}>${Status}`, [string, string]>> = {
  "draft>running": ["Starting", "Starts at"],
  "paused>running": ["Resuming", "Resumes at"],
  "running>paused": ["Pausing", "Pauses at"],
  "running>completed": ["Stopping", "Stops at"],
  "paused>completed": ["Stopping", "Stops at"],
  "draft>archived": ["Archiving", "Archived at"],
  "completed>archived": ["Archiving", "Archived at"],
};

export function experimentPhase(definition: ExperimentDefinition, now: number): Phase {
  const effective = effectiveStatus(definition, now);
  if (effective !== definition.status && definition.statusChangeAt) {
    const [verb, changeLabel] = VERB[`${effective}>${definition.status}`] ?? [
      "Changing",
      "Changes at",
    ];
    return {
      label: verb,
      changeLabel,
      tone: "warning",
      detail: `Takes effect for every member at the time shown. Until then they're assigned as while it was ${effective}.`,
      changesAt: definition.statusChangeAt,
      effective,
    };
  }
  switch (definition.status) {
    case "running": {
      if (definition.startsAt && Date.parse(definition.startsAt) > now) {
        return {
          label: "Scheduled",
          changeLabel: "Starts at",
          tone: "info",
          detail: "Running, and members are assigned from its start time.",
          changesAt: definition.startsAt,
          effective,
        };
      }
      if (definition.endsAt && Date.parse(definition.endsAt) <= now) {
        return {
          label: "Window over",
          changeLabel: null,
          tone: "outline",
          detail:
            "Still running, but its end time has passed: nobody new is assigned. Stop it to finish.",
          changesAt: null,
          effective,
        };
      }
      return {
        label: "Live",
        changeLabel: definition.endsAt ? "Ends at" : null,
        tone: "positive",
        detail: definition.endsAt ? "Assigning members until its end time." : null,
        changesAt: definition.endsAt,
        effective,
      };
    }
    case "paused":
      return {
        label: "Paused",
        changeLabel: null,
        tone: "warning",
        detail: "Nobody is assigned while paused.",
        changesAt: null,
        effective,
      };
    case "draft":
      return {
        label: "Draft",
        changeLabel: null,
        tone: "outline",
        detail: null,
        changesAt: null,
        effective,
      };
    case "completed":
      return {
        label: "Completed",
        changeLabel: null,
        tone: "info",
        detail: null,
        changesAt: null,
        effective,
      };
    case "archived":
      return {
        label: "Archived",
        changeLabel: null,
        tone: "outline",
        detail: null,
        changesAt: null,
        effective,
      };
  }
}

/** Status changes staff may make (the experiments service's transitions). */
export const TRANSITIONS: Record<Status, Status[]> = {
  draft: ["running", "archived"],
  running: ["paused", "completed"],
  paused: ["running", "completed"],
  completed: ["archived"],
  archived: [],
};

export function actionLabel(from: Status, to: Status): string {
  if (to === "running") return from === "paused" ? "Resume" : "Start";
  if (to === "paused") return "Pause";
  if (to === "completed") return "Stop";
  return "Archive";
}
