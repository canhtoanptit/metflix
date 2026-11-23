/** The audit log in words, the privacy backlog's warnings, and what staff may record of consent. */
import {
  AUDIT_READ_ACTIONS,
  type AuditLogEntry,
  ConsentState,
  SystemHealth,
} from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { withdrawablePurposes } from "../src/features/members/actions.tsx";
import { auditKind, auditShow } from "../src/features/operations/audit-filter.ts";
import { auditError, auditHeadline, auditTarget } from "../src/features/operations/audit-words.ts";
import {
  backlogCount,
  formatAge,
  PRIVACY_WARNING_AGE_SEC,
  privacyBacklog,
} from "../src/features/operations/privacy-backlog.ts";

const entry = (overrides: Partial<AuditLogEntry>): AuditLogEntry => ({
  id: "e1",
  actor: { type: "staff", id: "s1", name: "Sam" },
  action: "billing.refund",
  target: { type: "member", id: "acc-1" },
  before: null,
  after: null,
  reason: "Goodwill",
  requestId: "r1",
  createdAt: "2026-11-23T10:00:00.000Z",
  outcome: "succeeded",
  completedAt: "2026-11-23T10:00:01.000Z",
  kind: "action",
  targetLabel: "jane@example.test",
  facts: {},
  ...overrides,
});

describe("audit entries in words", () => {
  it("say what happened with its amount, and only what was asked when it didn't succeed", () => {
    const amount = { amountMinor: 400, currency: "USD" };
    expect(auditHeadline(entry({ facts: { amount, status: "succeeded" } }))).toBe("Refunded $4.00");
    expect(auditHeadline(entry({ facts: { amount, status: "pending" } }))).toMatch(
      /^Refund of \$4\.00 sent/,
    );
    expect(auditHeadline(entry({ outcome: "failed", facts: { error: "provider_error" } }))).toBe(
      "Refund",
    );
    expect(auditHeadline(entry({ outcome: "unknown" }))).toBe("Refund");
    expect(
      auditHeadline(
        entry({ action: "billing.trial_extended", outcome: "pending", facts: { days: 7 } }),
      ),
    ).toBe("Extend the trial by 7 days");
    expect(
      auditHeadline(
        entry({
          action: "billing.subscription_canceled",
          facts: { when: "now", amount: { amountMinor: 250, currency: "USD" } },
        }),
      ),
    ).toBe("Cancelled the membership now, refunded $2.50");
    expect(
      auditHeadline(
        entry({
          action: "privacy.consent_recorded",
          facts: { purpose: "personalisation", granted: false },
        }),
      ),
    ).toBe("Recorded a withdrawal of personalisation");
    // Facts withheld (your own actions): never guessed.
    expect(auditHeadline(entry({ action: "privacy.consent_recorded", outcome: "failed" }))).toBe(
      "Record a consent answer",
    );
    expect(auditHeadline(entry({ action: "member.viewed", kind: "read" }))).toBe("Viewed a member");
    expect(auditHeadline(entry({ action: "audit.read", kind: "read", facts: { count: 1 } }))).toBe(
      "Read the audit log: 1 entry",
    );
  });

  it("word every action the staff API records, and make an unknown code readable", () => {
    for (const action of AUDIT_READ_ACTIONS) {
      expect(auditHeadline(entry({ action, kind: "read" }))).not.toContain(".");
    }
    expect(auditHeadline(entry({ action: "billing.something_new" }))).toBe(
      "Billing: something new",
    );
  });

  it("name the member by address, or as erased, and a search by its shape only", () => {
    expect(auditTarget(entry({}))).toEqual({
      kind: "Member",
      label: "jane@example.test",
      memberId: "acc-1",
      erased: false,
    });
    expect(
      auditTarget(entry({ target: { type: "member", id: "erased:acc-1" }, targetLabel: null })),
    ).toEqual({ kind: "Member", label: "Erased member", memberId: null, erased: true });
    expect(
      auditTarget(entry({ target: { type: "member_search", id: "j***@e***" }, targetLabel: null }))
        .label,
    ).toBe("for “j***@e***”");
    expect(
      auditTarget(entry({ target: { type: "plan_price", id: "standard.USD" }, targetLabel: null }))
        .label,
    ).toBe("Standard, USD");
  });

  it("say a failure's error by its title", () => {
    expect(auditError(entry({ facts: { error: "subscription_required" } }))).toEqual({
      title: "An active membership is required",
      code: "subscription_required",
    });
    expect(auditError(entry({}))).toBeNull();
  });

  it("list actions by default, everything when following a request, and views when asked", () => {
    expect(auditKind(auditShow({}))).toBe("action");
    expect(auditKind(auditShow({ requestId: "r1" }))).toBeUndefined();
    expect(auditKind(auditShow({ show: "views" }))).toBe("read");
    expect(auditKind(auditShow({ show: "actions", requestId: "r1" }))).toBe("action");
  });
});

describe("the privacy backlog", () => {
  const privacy = (overrides: Partial<SystemHealth["privacy"]>): SystemHealth["privacy"] =>
    SystemHealth.shape.privacy.parse({
      pendingErasures: 0,
      oldestPendingErasureAt: null,
      oldestPendingErasureAgeSec: null,
      waitingExports: 0,
      oldestWaitingExportAt: null,
      oldestWaitingExportAgeSec: null,
      erasuresInProgress: 0,
      oldestErasureInProgressAt: null,
      oldestErasureInProgressAgeSec: null,
      ...overrides,
    });
  const at = "2026-11-23T00:00:00.000Z";

  it("warns only past each line's normal wait", () => {
    const quiet = privacyBacklog(privacy({}));
    expect(quiet.every((line) => !line.warning)).toBe(true);
    const onTime = privacyBacklog(
      privacy({
        pendingErasures: 3,
        oldestPendingErasureAt: at,
        oldestPendingErasureAgeSec: PRIVACY_WARNING_AGE_SEC.pendingErasure,
        waitingExports: 1,
        oldestWaitingExportAt: at,
        oldestWaitingExportAgeSec: 80 * 60,
        erasuresInProgress: 1,
        oldestErasureInProgressAt: at,
        oldestErasureInProgressAgeSec: 5 * 60,
      }),
    );
    expect(onTime.filter((line) => line.warning)).toEqual([]);
    const late = privacyBacklog(
      privacy({
        pendingErasures: 500,
        oldestPendingErasureAt: at,
        oldestPendingErasureAgeSec: 31 * 3600,
        waitingExports: 2,
        oldestWaitingExportAt: at,
        oldestWaitingExportAgeSec: 2 * 3600 + 1,
        erasuresInProgress: 1,
        oldestErasureInProgressAt: at,
        oldestErasureInProgressAgeSec: 16 * 60,
      }),
    );
    expect(late.filter((line) => line.warning).map((line) => line.id)).toEqual([
      "erasures-in-progress",
      "pending-erasures",
      "waiting-exports",
    ]);
    expect(backlogCount(500)).toBe("500+");
  });

  it("says ages in words", () => {
    expect(formatAge(42)).toBe("42 s");
    expect(formatAge(16 * 60)).toBe("16 min");
    expect(formatAge(3 * 3600 + 20 * 60)).toBe("3 h 20 min");
    expect(formatAge(52 * 3600)).toBe("2 days 4 h");
  });
});

describe("consent staff may record", () => {
  it("is a withdrawal of a purpose in force, nothing else", () => {
    const state = ConsentState.parse({
      mode: "opt-in",
      gpc: false,
      promptRequired: false,
      purposes: {
        analytics: { granted: true, source: "settings", updatedAt: "2026-11-01T00:00:00.000Z" },
        personalisation: { granted: false, source: null, updatedAt: null },
      },
    });
    expect(withdrawablePurposes(state)).toEqual(["analytics"]);
  });
});
