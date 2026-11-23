/**
 * The headline facts of an audit entry (`AuditLogEntry.facts`), derived when the log is read
 * from what the entry keeps: a refund's amount, a plan, a period, a status. Never stored as
 * such, so an erasure (which empties `before` and `after`) or a withheld view (`GET /audit/mine`)
 * leaves nothing of them but the error code.
 */
import { type AuditFacts, CONSENT_PURPOSES, PLAN_IDS } from "@webflix/contracts";
import type { AuditLogRecord } from "./repository.ts";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, name: string): unknown =>
  isRecord(value) ? value[name] : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 200 ? value : undefined;
const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

function money(value: unknown): AuditFacts["amount"] {
  const amountMinor = whole(field(value, "amountMinor"));
  const currency = text(field(value, "currency"));
  return amountMinor !== undefined && amountMinor >= 0 && currency && /^[A-Z]{3}$/.test(currency)
    ? { amountMinor, currency }
    : undefined;
}

function planId(value: unknown): AuditFacts["planId"] {
  return (PLAN_IDS as readonly unknown[]).includes(value)
    ? (value as AuditFacts["planId"])
    : undefined;
}

/** Only the facts present; undefined members are left out. */
function compact(facts: AuditFacts): AuditFacts {
  return Object.fromEntries(
    Object.entries(facts).filter(([, value]) => value !== undefined),
  ) as AuditFacts;
}

export function auditFacts(record: AuditLogRecord): AuditFacts {
  const request = field(record.before, "request");
  const after = record.after;
  const error = text(field(after, "error"));
  const facts: AuditFacts = { error };
  switch (record.action) {
    case "billing.refund":
      facts.amount = money(field(after, "amount"));
      facts.status = text(field(after, "status"));
      break;
    case "billing.subscription_canceled": {
      const when = field(request, "when");
      facts.when = when === "now" || when === "period_end" ? when : undefined;
      facts.amount = money(field(field(after, "refund"), "amount"));
      facts.status = text(field(field(after, "membership"), "status"));
      facts.planId = planId(field(field(after, "membership"), "planId"));
      break;
    }
    case "billing.trial_extended":
    case "billing.complimentary_period_granted":
      facts.days = whole(field(request, "days"));
      facts.status = text(field(after, "status"));
      facts.planId = planId(field(after, "planId"));
      break;
    case "billing.price_set": {
      const [plan, currency] = record.target.id.split(".");
      facts.planId = planId(plan);
      facts.amount = money({ amountMinor: field(after, "amountMinor"), currency });
      break;
    }
    case "privacy.consent_recorded": {
      const purpose = field(request, "purpose");
      facts.purpose = (CONSENT_PURPOSES as readonly unknown[]).includes(purpose)
        ? (purpose as AuditFacts["purpose"])
        : undefined;
      const granted = field(request, "granted");
      facts.granted = typeof granted === "boolean" ? granted : undefined;
      break;
    }
    case "editorial.billboard_set":
      facts.titleCount = Array.isArray(after) ? after.length : undefined;
      break;
    case "editorial.collection_create":
    case "editorial.collection_update": {
      const titleIds = field(after, "titleIds");
      facts.titleCount = Array.isArray(titleIds) ? titleIds.length : undefined;
      facts.status = text(field(after, "status"));
      break;
    }
    case "editorial.availability_set": {
      const available = field(after, "available");
      facts.available = typeof available === "boolean" ? available : undefined;
      break;
    }
    case "experiment.status":
    case "experiment.create":
    case "experiment.update":
      facts.status = text(field(after, "status"));
      break;
    case "system.recommendations_import_requested":
      facts.outcome = text(field(after, "outcome"));
      facts.run = text(field(after, "run"));
      break;
    case "privacy.erasures_confirmed":
      facts.count = whole(field(after, "confirmed"));
      break;
    default: {
      // Reads keep how many results they gave.
      const count = whole(field(after, "results")) ?? whole(field(after, "count"));
      facts.count = count !== undefined && count >= 0 ? count : undefined;
    }
  }
  return compact(facts);
}
