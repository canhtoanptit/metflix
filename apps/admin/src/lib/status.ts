/** Words and badge tones for the states the staff API reports. Colour is never the only signal. */
import type {
  AuditOutcome,
  ExperimentDefinition,
  Invoice,
  MemberDetail,
  MembershipState,
  PrivacyRequest,
} from "@webflix/contracts";
import type { BadgeTone } from "@webflix/ui";

type Status<T extends string> = Record<T, { label: string; tone: BadgeTone }>;

export const MEMBERSHIP: Status<MembershipState["status"]> = {
  none: { label: "No membership", tone: "outline" },
  incomplete: { label: "Payment pending", tone: "warning" },
  trialing: { label: "Trial", tone: "info" },
  active: { label: "Active", tone: "positive" },
  past_due: { label: "Past due", tone: "warning" },
  suspended: { label: "Suspended", tone: "danger" },
  canceled: { label: "Ended", tone: "outline" },
};

export const ENTITLEMENT: Record<MemberDetail["entitlement"]["reason"], string> = {
  entitled: "Can watch",
  no_membership: "No membership",
  payment_pending: "Waiting for the first payment",
  suspended: "Suspended",
  ended: "Membership ended",
};

export const SUSPENDED_REASON: Record<NonNullable<MembershipState["suspendedReason"]>, string> = {
  grace_expired: "Grace period ran out",
  unpaid: "Marked unpaid by the provider",
  paused: "Paused at the provider",
};

export const INVOICE: Status<Invoice["status"]> = {
  draft: { label: "Draft", tone: "outline" },
  open: { label: "Open", tone: "warning" },
  paid: { label: "Paid", tone: "positive" },
  void: { label: "Void", tone: "outline" },
  uncollectible: { label: "Uncollectible", tone: "danger" },
};

export const AUDIT_OUTCOME: Status<AuditOutcome> = {
  pending: { label: "Pending", tone: "warning" },
  succeeded: { label: "Succeeded", tone: "positive" },
  failed: { label: "Failed", tone: "danger" },
  unknown: { label: "Unknown", tone: "warning" },
};

export const PRIVACY_REQUEST: Status<PrivacyRequest["status"]> = {
  pending: { label: "Pending", tone: "warning" },
  scheduled: { label: "Scheduled", tone: "info" },
  processing: { label: "Processing", tone: "info" },
  completed: { label: "Completed", tone: "positive" },
  canceled: { label: "Canceled", tone: "outline" },
  failed: { label: "Failed", tone: "danger" },
};

export const EXPERIMENT: Status<ExperimentDefinition["status"]> = {
  draft: { label: "Draft", tone: "outline" },
  running: { label: "Running", tone: "positive" },
  paused: { label: "Paused", tone: "warning" },
  completed: { label: "Completed", tone: "info" },
  archived: { label: "Archived", tone: "outline" },
};

export const PLAN_NAMES: Record<string, string> = {
  basic: "Basic",
  standard: "Standard",
  premium: "Premium",
};

export function planName(planId: string | null): string {
  return planId ? (PLAN_NAMES[planId] ?? planId) : "—";
}

export const VIEW_LABELS = {
  home: "Home",
  series: "Series",
  movies: "Movies",
  "new-popular": "New & Popular",
} as const;
