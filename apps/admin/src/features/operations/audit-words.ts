/**
 * An audit entry in words: what happened (with the amount, the days, the plan, the status that
 * the entry's `facts` carry), to whom or what (`targetLabel`: a member's current address, "Erased
 * member", a title's or a collection's name), and how a failure ended. The action's code stays in
 * the entry's details for whoever needs it.
 *
 * A change that did not succeed is named as what was asked ("Refund", "Extend trial by 7 days"),
 * never in the past tense: the outcome badge says how it ended.
 *
 * `targetLabel` is a member's personal data: shown on screen only, never put in a URL, a page
 * title or a log line.
 */
import {
  type AuditFacts,
  type AuditLogEntry,
  ERASED_MEMBER_LABEL,
  ERROR_CATALOG,
} from "@webflix/contracts";
import { formatMoney, plural } from "../../lib/format.ts";
import { EXPERIMENT, planName, VIEW_LABELS } from "../../lib/status.ts";

interface Phrase {
  /** What was asked: an action that failed, is pending or ended unknown. */
  asked: (facts: AuditFacts) => string;
  /** What happened: an action that succeeded, or a read. */
  done: (facts: AuditFacts) => string;
}

const PURPOSES: Record<string, string> = {
  analytics: "analytics",
  personalisation: "personalisation",
};

const days = (facts: AuditFacts) =>
  facts.days !== undefined ? plural(facts.days, "day", "days") : null;
const money = (facts: AuditFacts) => (facts.amount ? formatMoney(facts.amount) : null);
const titles = (facts: AuditFacts) =>
  facts.titleCount !== undefined ? plural(facts.titleCount, "title", "titles") : null;
const purpose = (facts: AuditFacts) =>
  facts.purpose ? (PURPOSES[facts.purpose] ?? facts.purpose) : "a purpose";

function same(text: string): Phrase {
  return { asked: () => text, done: () => text };
}

const IMPORT_OUTCOMES: Record<string, (run: string | undefined) => string> = {
  queued: (run) => `Queued the import of run ${run ?? "(unnamed)"}`,
  nothing_published: () => "Asked for an import: nothing was published",
  already_served: (run) => `Asked for an import: run ${run ?? "(unnamed)"} was already served`,
  invalid: () => "Asked for an import: the published run was unusable",
  no_artefact_store: () => "Asked for an import: no store to import from",
};

const PHRASES: Record<string, Phrase> = {
  // Members (support)
  "member.signed_out_everywhere": {
    asked: () => "Sign out everywhere",
    done: () => "Signed out everywhere",
  },
  "member.password_reset_sent": {
    asked: () => "Send a password reset",
    done: () => "Sent a password reset",
  },
  "member.pin_removed": {
    asked: () => "Remove a profile PIN",
    done: () => "Removed a profile PIN",
  },
  "privacy.consent_recorded": {
    // Without the facts (your own actions, an erased member) it may have been either answer.
    asked: (facts) =>
      facts.granted === true
        ? `Record ${purpose(facts)} as turned on`
        : facts.granted === false
          ? `Record a withdrawal of ${purpose(facts)}`
          : "Record a consent answer",
    done: (facts) =>
      facts.granted === true
        ? `Recorded ${purpose(facts)} as turned on`
        : facts.granted === false
          ? `Recorded a withdrawal of ${purpose(facts)}`
          : "Recorded a consent answer",
  },
  "privacy.deletion_canceled": {
    asked: () => "Cancel the account deletion",
    done: () => "Cancelled the account deletion",
  },
  // Billing
  "billing.refund": {
    asked: (facts) => (money(facts) ? `Refund ${money(facts)}` : "Refund"),
    done: (facts) => {
      const amount = money(facts);
      if (!amount) return "Refunded";
      if (facts.status === "pending")
        return `Refund of ${amount} sent, the provider still processing it`;
      if (facts.status === "failed") return `Refund of ${amount} refused by the provider`;
      return `Refunded ${amount}`;
    },
  },
  "billing.subscription_canceled": {
    asked: (facts) =>
      facts.when === "now"
        ? "Cancel the membership now"
        : facts.when === "period_end"
          ? "Cancel the membership at the period end"
          : "Cancel the membership",
    done: (facts) => {
      const when =
        facts.when === "now" ? " now" : facts.when === "period_end" ? " at the period end" : "";
      const refund = money(facts) ? `, refunded ${money(facts)}` : "";
      return `Cancelled the membership${when}${refund}`;
    },
  },
  "billing.trial_extended": {
    asked: (facts) => (days(facts) ? `Extend the trial by ${days(facts)}` : "Extend the trial"),
    done: (facts) => (days(facts) ? `Extended the trial by ${days(facts)}` : "Extended the trial"),
  },
  "billing.complimentary_period_granted": {
    asked: (facts) => (days(facts) ? `Give ${days(facts)} free` : "Give free time"),
    done: (facts) => (days(facts) ? `Gave ${days(facts)} free` : "Gave free time"),
  },
  "billing.price_set": {
    asked: (facts) =>
      `Set the ${facts.planId ? planName(facts.planId) : "plan"} price${money(facts) ? ` to ${money(facts)}` : ""}`,
    done: (facts) =>
      `Set the ${facts.planId ? planName(facts.planId) : "plan"} price${money(facts) ? ` to ${money(facts)}` : ""}`,
  },
  "billing.plans_synced": {
    asked: () => "Sync the plans with the payment provider",
    done: () => "Synced the plans with the payment provider",
  },
  // Content
  "editorial.billboard_set": {
    asked: () => "Set the billboard",
    done: (facts) => (titles(facts) ? `Set the billboard: ${titles(facts)}` : "Set the billboard"),
  },
  "editorial.collection_create": {
    asked: () => "Create a collection",
    done: (facts) =>
      `Created a collection${titles(facts) ? `: ${titles(facts)}` : ""}${facts.status ? `, ${facts.status}` : ""}`,
  },
  "editorial.collection_update": {
    asked: () => "Edit a collection",
    done: (facts) =>
      `Edited a collection${titles(facts) ? `: ${titles(facts)}` : ""}${facts.status ? `, ${facts.status}` : ""}`,
  },
  "editorial.collection_delete": {
    asked: () => "Delete a collection",
    done: () => "Deleted a collection",
  },
  "editorial.availability_set": {
    asked: () => "Set a title's availability",
    done: (facts) =>
      facts.available === true
        ? "Made a title available"
        : facts.available === false
          ? "Made a title unavailable"
          : "Set a title's availability",
  },
  // Experiments
  "experiment.create": {
    asked: () => "Create an experiment",
    done: () => "Created an experiment",
  },
  "experiment.update": { asked: () => "Edit an experiment", done: () => "Edited an experiment" },
  "experiment.status": {
    asked: (facts) =>
      facts.status
        ? `Set an experiment to ${experimentStatus(facts.status)}`
        : "Change an experiment's status",
    done: (facts) =>
      facts.status
        ? `Set an experiment to ${experimentStatus(facts.status)}`
        : "Changed an experiment's status",
  },
  // Operations
  "system.dead_letter_replayed": {
    asked: () => "Replay a failed job",
    done: () => "Replayed a failed job",
  },
  "system.recommendations_import_requested": {
    asked: () => "Import recommendations",
    done: (facts) =>
      (facts.outcome ? IMPORT_OUTCOMES[facts.outcome]?.(facts.run) : undefined) ??
      "Asked for a recommendations import",
  },
  "system.recommendations_rolled_back": {
    asked: () => "Roll back recommendations",
    done: () => "Rolled back recommendations",
  },
  "privacy.erasures_confirmed": {
    asked: () => "Confirm erasures from the event lake",
    done: (facts) =>
      facts.count !== undefined
        ? `Confirmed ${plural(facts.count, "erasure", "erasures")} from the event lake`
        : "Confirmed erasures from the event lake",
  },
  "privacy.export_events_recorded": {
    asked: () => "Record data export results",
    done: () => "Recorded data export results",
  },
  // Reads: no change, recorded because staff looked
  "member.viewed": same("Viewed a member"),
  "member.searched": {
    asked: () => "Searched members",
    done: (facts) =>
      facts.count !== undefined
        ? `Searched members: ${plural(facts.count, "result", "results")}`
        : "Searched members",
  },
  "member.privacy_viewed": same("Viewed a member's privacy details"),
  "audit.read": {
    asked: () => "Read the audit log",
    done: (facts) =>
      facts.count !== undefined
        ? `Read the audit log: ${plural(facts.count, "entry", "entries")}`
        : "Read the audit log",
  },
  "privacy.erasures_listed": {
    asked: () => "Listed the erasures waiting for the lake",
    done: (facts) =>
      facts.count !== undefined
        ? `Listed the erasures waiting for the lake: ${facts.count}`
        : "Listed the erasures waiting for the lake",
  },
  "privacy.exports_listed": {
    asked: () => "Listed the data exports waiting for events",
    done: (facts) =>
      facts.count !== undefined
        ? `Listed the data exports waiting for events: ${facts.count}`
        : "Listed the data exports waiting for events",
  },
};

function experimentStatus(status: string): string {
  return status in EXPERIMENT
    ? EXPERIMENT[status as keyof typeof EXPERIMENT].label.toLowerCase()
    : status;
}

/** An action code nobody has worded yet, made readable: `billing.price_set` → "Billing: price set". */
function fallback(action: string): string {
  const [area = action, ...rest] = action.split(".");
  const what = rest.join(" ").replaceAll("_", " ");
  const head = area.charAt(0).toUpperCase() + area.slice(1).replaceAll("_", " ");
  return what ? `${head}: ${what}` : head;
}

/** The headline of an entry: what happened, or what was asked when it didn't succeed. */
export function auditHeadline(entry: Pick<AuditLogEntry, "action" | "outcome" | "facts">): string {
  const phrase = PHRASES[entry.action];
  if (!phrase) return fallback(entry.action);
  return entry.outcome === "succeeded" ? phrase.done(entry.facts) : phrase.asked(entry.facts);
}

export const TARGET_TYPES: Record<string, string> = {
  member: "Member",
  member_search: "Member search",
  plan_price: "Plan price",
  plan_catalogue: "Plan catalogue",
  billboard: "Billboard",
  collection: "Collection",
  title: "Title",
  experiment: "Experiment",
  dead_letter: "Failed job",
  recommendations: "Recommendations",
  event_lake: "Event lake",
  audit_log: "Audit log",
};

export interface TargetWords {
  /** "Member", "Collection"… */
  kind: string;
  /** The target in words: an address, a name, a key; null when there is nothing to add. */
  label: string | null;
  /** A member the console can open (not erased): their account id. */
  memberId: string | null;
  erased: boolean;
}

/** Whom or what an entry is about, in words. */
export function auditTarget(entry: Pick<AuditLogEntry, "target" | "targetLabel">): TargetWords {
  const { type, id } = entry.target;
  const kind = TARGET_TYPES[type] ?? type;
  const erased = id.startsWith("erased:");
  if (type === "member") {
    return {
      kind,
      label: erased ? ERASED_MEMBER_LABEL : (entry.targetLabel ?? null),
      memberId: erased ? null : id,
      erased,
    };
  }
  if (type === "member_search") {
    // The shape of what was typed (`j***@e***`), never the query itself.
    return { kind, label: `for “${id}”`, memberId: null, erased: false };
  }
  if (type === "billboard") {
    return {
      kind,
      label: VIEW_LABELS[id as keyof typeof VIEW_LABELS] ?? id,
      memberId: null,
      erased: false,
    };
  }
  if (type === "plan_price") {
    const [plan, currency] = id.split(".");
    return {
      kind,
      label: plan && currency ? `${planName(plan)}, ${currency}` : id,
      memberId: null,
      erased: false,
    };
  }
  if (type === "audit_log" || type === "recommendations" || type === "plan_catalogue") {
    return { kind, label: null, memberId: null, erased: false };
  }
  if (type === "event_lake") {
    return {
      kind,
      label: id === "erasures" ? "erasures" : id === "exports" ? "data exports" : id,
      memberId: null,
      erased: false,
    };
  }
  return { kind, label: entry.targetLabel ?? id, memberId: null, erased: false };
}

/** How a failed or unknown action ended, in words (its error code's title); null when none. */
export function auditError(
  entry: Pick<AuditLogEntry, "facts">,
): { title: string; code: string } | null {
  const code = entry.facts.error;
  if (!code) return null;
  const known = (ERROR_CATALOG as Record<string, { title: string } | undefined>)[code];
  return { title: known?.title ?? code, code };
}
