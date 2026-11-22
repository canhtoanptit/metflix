/**
 * The staff API's behaviour over HTTP on memory ports (milestone 2 §8.3): each action reaches the
 * owning area's service and leaves its audit entry; the entry of an identity, billing, events or
 * system action exists before the action runs and is settled after it, whatever happens in
 * between; a retried refund never refunds twice; staff see what the task needs and no more.
 */
import {
  ADMIN_API_BASE_PATH,
  API_BASE_PATH,
  type AuditLogEntry,
  adminRoutes,
  createRouteClient,
} from "@webflix/contracts";
import { makeClientEventInput } from "@webflix/contracts/fixtures";
import { AppError, encodeLakeObject, hexEncode, PENDING_AUDIT_TIMEOUT_MS } from "@webflix/core";
import type { MemoryAdminRepository, MemoryStaffVerifier, MemoryStore } from "@webflix/core/memory";
import { describe, expect, it } from "vitest";
import { createTestApp, DEMO, type Device, onboard, type TestApp } from "./support.ts";

const KEY = "0193f7d2-aaaa-7bbb-8ccc-000000000001";

function staffClient(t: TestApp, roles: string[], subject = "staff-ada") {
  const verifier = t.ports.staff as MemoryStaffVerifier;
  return createRouteClient(adminRoutes, {
    basePath: ADMIN_API_BASE_PATH,
    validateResponses: true,
    headers: async () => ({
      Authorization: `Bearer ${await verifier.mint({
        subject,
        name: "Ada Support",
        email: "ada@staff.test",
        clientRoles: { "webflix-admin": roles },
      })}`,
      "X-Request-Id": "req-staff-1",
    }),
    fetch: async (url, init) => t.app.request(url, init),
  });
}

async function rawStaff(
  t: TestApp,
  roles: string[],
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = await (t.ports.staff as MemoryStaffVerifier).mint({
    subject: "staff-ada",
    clientRoles: { "webflix-admin": roles },
  });
  return t.request(`${ADMIN_API_BASE_PATH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Webflix-Client": "web",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const auditRows = (t: TestApp) => (t.deps.repos.admin as MemoryAdminRepository).audit;

async function accountIdOf(device: Device): Promise<string> {
  const session = await device.api.getSession({ query: {} });
  if (!session.authenticated) throw new Error("signed out");
  return session.account.id;
}

/**
 * A member whose membership is the provider's, with a paid invoice: a first account takes the
 * card's one trial, so this one pays its first invoice at once.
 */
async function payingMember(t: TestApp, email: string) {
  const subscribe = async (address: string) => {
    const device = t.device();
    await device.api.signup({ body: { email: address, password: "correct horse battery" } });
    const started = await device.api.startCheckout({ body: { planId: "basic" } });
    if (!started.clientSecret) throw new Error("no setup secret");
    await t.ports.payments.confirmSetup(started.clientSecret, "visa");
    const confirmed = await device.api.confirmCheckout({ params: { id: started.id } });
    if (confirmed.status === "requires_payment" && confirmed.clientSecret) {
      await t.ports.payments.confirmPayment(confirmed.clientSecret, "visa");
    }
    for (let i = 0; i < 5; i += 1) {
      await t.queue.drain();
      if ((await device.api.getCheckout({ params: { id: started.id } })).status === "complete") {
        break;
      }
    }
    return { device, accountId: await accountIdOf(device) };
  };
  await subscribe(`trial-${email}`);
  const paying = await subscribe(email);
  // Reading a member's record is support's; a billing agent holds both roles.
  const detail = await staffClient(t, ["support", "billing"]).getMember({
    params: { accountId: paying.accountId },
  });
  const invoice = detail.recentInvoices.find((candidate) => candidate.amountPaid.amountMinor > 0);
  if (!invoice) throw new Error("no paid invoice");
  return { ...paying, invoice };
}

describe("member support", () => {
  it("finds a member, shows their record, and audits both reads", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "found@example.test" });
    const accountId = await accountIdOf(device);
    const staff = staffClient(t, ["support"]);
    const page = await staff.searchMembers({ query: { q: "found@" } });
    expect(page.items).toEqual([
      expect.objectContaining({ accountId, email: "found@example.test", isDemo: false }),
    ]);
    const detail = await staff.getMember({ params: { accountId } });
    expect(detail.account).toMatchObject({ id: accountId, hasPassword: true });
    expect(detail.profiles).toHaveLength(1);
    expect(detail.activeDevices).toBe(1);
    const reads = auditRows(t).map((row) => [row.action, row.target, row.outcome, row.reason]);
    expect(reads).toEqual([
      ["member.searched", { type: "member_search", id: "found@" }, "succeeded", null],
      ["member.viewed", { type: "member", id: accountId }, "succeeded", null],
    ]);
    // No data leaves when its read cannot be audited.
    const admin = t.deps.repos.admin as MemoryAdminRepository;
    admin.appendAudit = async () => {
      throw new Error("audit log down");
    };
    const refused = await rawStaff(t, ["support"], "GET", `/members/${accountId}`);
    expect(refused.status).toBe(500);
    expect(JSON.stringify(await refused.json())).not.toContain("found@example.test");
  });

  it("carries no password hash, token, PIN hash or invoice link in a member's record", async () => {
    const t = await createTestApp();
    const { accountId } = await payingMember(t, "least@example.test");
    // A provider that offers hosted invoice pages (Stripe does): bearer links to the member's
    // invoice, which the member sees on their own invoices.
    const billing = t.services.billing;
    const memberBilling = billing.memberBilling.bind(billing);
    billing.memberBilling = async (id) => {
      const real = await memberBilling(id);
      return {
        ...real,
        recentInvoices: real.recentInvoices.map((invoice) => ({
          ...invoice,
          hostedUrl: "https://invoice.provider.test/i/secret-link",
          pdfUrl: "https://invoice.provider.test/i/secret-link.pdf",
        })),
      };
    };
    const response = await rawStaff(t, ["support"], "GET", `/members/${accountId}`);
    const text = await response.text();
    expect(response.status).toBe(200);
    for (const forbidden of ["$pbkdf2", "$scrypt", "pinHash", "passwordHash", "token", "secret"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).not.toContain("secret-link");
    const detail = JSON.parse(text);
    expect(detail.recentInvoices.length).toBeGreaterThan(0);
    for (const invoice of detail.recentInvoices) {
      expect(invoice.hostedUrl).toBeNull();
      expect(invoice.pdfUrl).toBeNull();
    }
  });

  it("signs a member out everywhere, with an entry saying who, what, on whom, why and how it went", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "signed-out@example.test" });
    const accountId = await accountIdOf(device);
    await staffClient(t, ["support"]).signOutMemberEverywhere({
      params: { accountId },
      body: { reason: "Account takeover reported (ticket 77)" },
    });
    const session = await device.api.getSession({ query: {} });
    expect(session.authenticated).toBe(false);
    const [entry] = auditRows(t);
    expect(entry).toMatchObject({
      actor: { type: "staff", id: "staff-ada", name: "Ada Support" },
      action: "member.signed_out_everywhere",
      target: { type: "member", id: accountId },
      reason: "Account takeover reported (ticket 77)",
      requestId: "req-staff-1",
      outcome: "succeeded",
      after: { sessionsEnded: 1 },
    });
    expect(entry?.completedAt).not.toBeNull();
  });

  it("removes a PIN and sends a reset link; refuses the demo account, and audits the refusal", async () => {
    const t = await createTestApp();
    const { device, profileId } = await onboard(t, { email: "pin@example.test" });
    const accountId = await accountIdOf(device);
    await device.api.updateProfile({
      params: { id: profileId },
      body: { pin: "4826", currentPassword: "correct horse battery" },
    });
    const staff = staffClient(t, ["support"]);
    await staff.removeProfilePin({
      params: { accountId, profileId },
      body: { reason: "Member forgot the PIN (ticket 12)" },
    });
    const profiles = await device.api.listProfiles();
    expect(profiles.items.find((profile) => profile.id === profileId)?.isLocked).toBe(false);
    await staff.sendMemberPasswordReset({
      params: { accountId },
      body: { reason: "Asked by phone" },
    });
    await t.queue.drain();
    const mail = await t.ports.email.mailbox("pin@example.test");
    expect(mail.some((message) => message.template === "reset-password")).toBe(true);

    const demo = await staff.searchMembers({ query: { q: DEMO.email } });
    const demoId = demo.items[0]?.accountId ?? "";
    const refused = await rawStaff(t, ["support"], "POST", `/members/${demoId}/sign-out`, {
      reason: "Trying the demo",
    });
    expect((await refused.json()).code).toBe("demo_account_protected");
    const actions = auditRows(t)
      .filter((row) => row.action !== "member.searched")
      .map((row) => [row.action, row.outcome, row.after]);
    expect(actions).toEqual([
      ["member.pin_removed", "succeeded", { profileId, hadPin: true, locked: false }],
      ["member.password_reset_sent", "succeeded", { queued: true }],
      ["member.signed_out_everywhere", "failed", { error: "demo_account_protected" }],
    ]);
  });
});

describe("audit entries are inseparable from the identity, billing and events actions", () => {
  it("does not act when the entry cannot be written first", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "no-audit@example.test" });
    const accountId = await accountIdOf(device);
    const admin = t.deps.repos.admin as MemoryAdminRepository;
    admin.beginAudit = async () => {
      throw new AppError("service_unavailable", { detail: "The database cannot be reached" });
    };
    const response = await rawStaff(t, ["support"], "POST", `/members/${accountId}/sign-out`, {
      reason: "Takeover",
    });
    expect(response.status).toBe(503);
    // Still signed in: the action never ran.
    expect((await device.api.getSession({ query: {} })).authenticated).toBe(true);
  });

  it("keeps the entry, as unknown, when the call fails half-way (money moved, then an error)", async () => {
    const t = await createTestApp();
    const { accountId, invoice } = await payingMember(t, "half-way@example.test");
    // The provider refunds, then the invoice cannot be read back: the call fails after the
    // money moved.
    const payments = t.ports.payments;
    payments.retrieveInvoice = async () => {
      throw new Error("provider read timed out");
    };
    const response = await rawStaff(t, ["billing"], "POST", `/members/${accountId}/refunds`, {
      invoiceId: invoice.id,
      reason: "Charged twice",
      idempotencyKey: KEY,
    });
    expect(response.status).toBe(500);
    const entry = auditRows(t).find((row) => row.action === "billing.refund");
    expect(entry).toMatchObject({
      outcome: "unknown",
      after: { error: "internal_error" },
      idempotencyKey: KEY,
      reason: "Charged twice",
      before: { request: { invoiceId: invoice.id, amount: null } },
    });
    // The console retries the same request: never a second refund.
    const retry = await rawStaff(t, ["billing"], "POST", `/members/${accountId}/refunds`, {
      invoiceId: invoice.id,
      reason: "Charged twice",
      idempotencyKey: KEY,
    });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: "staff_action_conflict" });
    expect(
      (
        await payments.listInvoices({ customerId: await customerOf(t, accountId), limit: 10 })
      ).reduce((sum, candidate) => sum + candidate.amountRefundedMinor, 0),
    ).toBe(invoice.amountPaid.amountMinor);
  });

  it("shows the entry as pending while the provider is slow, and settles it after", async () => {
    const t = await createTestApp();
    const { accountId, invoice } = await payingMember(t, "slow@example.test");
    const payments = t.ports.payments;
    const original = payments.refund.bind(payments);
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    payments.refund = async (input, call) => {
      await slow;
      return original(input, call);
    };
    const pending = staffClient(t, ["billing"]).refundInvoice({
      params: { accountId },
      body: { invoiceId: invoice.id, reason: "Goodwill", idempotencyKey: KEY },
    });
    // While the provider has not answered, the audit log already says who, what and why.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const log = await staffClient(t, ["admin"]).listAuditLog({ query: { outcome: "pending" } });
    expect(log.items).toEqual([
      expect.objectContaining({
        action: "billing.refund",
        outcome: "pending",
        reason: "Goodwill",
        target: { type: "member", id: accountId },
        completedAt: null,
      }),
    ]);
    // A retry meanwhile does not refund again.
    const retry = await rawStaff(t, ["billing"], "POST", `/members/${accountId}/refunds`, {
      invoiceId: invoice.id,
      reason: "Goodwill",
      idempotencyKey: KEY,
    });
    expect(retry.status).toBe(409);
    expect((await retry.json()).detail).toMatch(/still running/);
    release();
    const refund = await pending;
    expect(refund.status).toBe("succeeded");
    const [settled] = (
      await staffClient(t, ["admin"]).listAuditLog({ query: { targetId: accountId } })
    ).items.filter((entry: AuditLogEntry) => entry.action === "billing.refund");
    expect(settled).toMatchObject({ outcome: "succeeded", after: refund });
  });

  it("returns the result when settling fails, and the sweep turns the open entry unknown", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "settle@example.test" });
    const accountId = await accountIdOf(device);
    const admin = t.deps.repos.admin as MemoryAdminRepository;
    const settle = admin.settleAudit;
    admin.settleAudit = async () => {
      throw new Error("audit log down after the action");
    };
    await staffClient(t, ["support"]).signOutMemberEverywhere({
      params: { accountId },
      body: { reason: "Takeover" },
    });
    expect((await device.api.getSession({ query: {} })).authenticated).toBe(false);
    expect(auditRows(t)[0]?.outcome).toBe("pending");
    expect(t.logger.records.some((record) => record.msg === "admin.audit_settle_failed")).toBe(
      true,
    );
    admin.settleAudit = settle;
    // Within the timeout the sweep leaves it; after it, the entry says the outcome is unknown.
    await t.services.scheduler.tick();
    await t.queue.drain();
    expect(auditRows(t)[0]?.outcome).toBe("pending");
    t.clock.advance(PENDING_AUDIT_TIMEOUT_MS + 1);
    await t.services.scheduler.tick();
    await t.queue.drain();
    expect(auditRows(t)[0]).toMatchObject({ outcome: "unknown", reason: "Takeover" });
  });
});

async function customerOf(t: TestApp, accountId: string): Promise<string> {
  const provider = t.services.billing.config().provider;
  const customer = await t.deps.repos.billing.getCustomer(accountId, provider);
  if (!customer) throw new Error("no customer");
  return customer.customerId;
}

describe("billing actions", () => {
  it("refunds once however often the request is retried, and answers the retry with the first response", async () => {
    const t = await createTestApp();
    const { accountId, invoice } = await payingMember(t, "refund@example.test");
    const staff = staffClient(t, ["billing"]);
    const body = {
      invoiceId: invoice.id,
      amount: { amountMinor: 100, currency: invoice.amountPaid.currency },
      reason: "Partial goodwill refund",
      idempotencyKey: KEY,
    };
    const first = await staff.refundInvoice({ params: { accountId }, body });
    // Retried in sequence and in parallel: the same refund every time.
    const again = await staff.refundInvoice({ params: { accountId }, body });
    const parallel = await Promise.all([
      rawStaff(t, ["billing"], "POST", `/members/${accountId}/refunds`, body),
      rawStaff(t, ["billing"], "POST", `/members/${accountId}/refunds`, body),
    ]);
    expect(again).toEqual(first);
    for (const response of parallel) {
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual(first);
    }
    const invoices = await t.ports.payments.listInvoices({
      customerId: await customerOf(t, accountId),
      limit: 10,
    });
    expect(invoices.reduce((sum, candidate) => sum + candidate.amountRefundedMinor, 0)).toBe(100);
    expect(auditRows(t).filter((row) => row.action === "billing.refund")).toHaveLength(1);

    // The same key for something else is refused; another staff member's key reuse too.
    const other = await rawStaff(t, ["billing"], "POST", `/members/${accountId}/refunds`, {
      ...body,
      amount: { amountMinor: 200, currency: invoice.amountPaid.currency },
    });
    expect(other.status).toBe(409);
    expect((await other.json()).detail).toMatch(/another request/);
    const bob = await staffClient(t, ["billing"], "staff-bob")
      .refundInvoice({ params: { accountId }, body })
      .catch((error: unknown) => error);
    expect(bob).toMatchObject({ problem: { code: "staff_action_conflict" } });

    // A new key is a new refund.
    const second = await staff.refundInvoice({
      params: { accountId },
      body: { ...body, idempotencyKey: `${KEY.slice(0, -1)}2` },
    });
    expect(second.id).not.toBe(first.id);
  });

  it("cancels now with a refund of the unused time, and the entry shows the money that moved", async () => {
    const t = await createTestApp();
    const { accountId, invoice } = await payingMember(t, "cancel-now@example.test");
    const staff = staffClient(t, ["billing"]);
    const body = {
      when: "now" as const,
      refundUnused: true,
      reason: "Moving abroad; refund the rest",
      idempotencyKey: KEY,
    };
    const membership = await staff.cancelMemberSubscription({ params: { accountId }, body });
    expect(membership.status).toBe("canceled");
    const [entry] = auditRows(t).filter((row) => row.action === "billing.subscription_canceled");
    const after = entry?.after as {
      membership: { status: string };
      refund: { invoiceId: string; amount: { amountMinor: number }; status: string } | null;
    };
    expect(entry?.outcome).toBe("succeeded");
    expect(after.membership).toEqual(membership);
    expect(after.refund).toMatchObject({ invoiceId: invoice.id, status: "succeeded" });
    expect(after.refund?.amount.amountMinor).toBeGreaterThan(0);
    expect(after.refund?.amount.amountMinor).toBeLessThanOrEqual(invoice.amountPaid.amountMinor);
    // A retry is answered from the entry: the same membership, no second refund.
    expect(await staff.cancelMemberSubscription({ params: { accountId }, body })).toEqual(
      membership,
    );
    const invoices = await t.ports.payments.listInvoices({
      customerId: await customerOf(t, accountId),
      limit: 10,
    });
    expect(invoices.reduce((sum, candidate) => sum + candidate.amountRefundedMinor, 0)).toBe(
      after.refund?.amount.amountMinor,
    );
    // At period end nothing is refunded, and the entry says so.
    const later = await payingMember(t, "cancel-later@example.test");
    await staff.cancelMemberSubscription({
      params: { accountId: later.accountId },
      body: { when: "period_end", reason: "Member asked", idempotencyKey: `${KEY.slice(0, -1)}9` },
    });
    const periodEnd = auditRows(t).find(
      (row) => row.action === "billing.subscription_canceled" && row.target.id === later.accountId,
    );
    expect(periodEnd?.after).toMatchObject({ refund: null });
  });

  it("requires an idempotency key on every billing action", async () => {
    const t = await createTestApp();
    for (const path of [
      "refunds",
      "subscription/cancel",
      "subscription/extend-trial",
      "subscription/complimentary",
    ]) {
      const response = await rawStaff(t, ["billing"], "POST", `/members/acct-1/${path}`, {
        invoiceId: "inv-1",
        when: "period_end",
        days: 3,
        reason: "No key",
      });
      expect(response.status, path).toBe(400);
      const problem = await response.json();
      expect(
        problem.issues.map((issue: { path: string }) => issue.path),
        path,
      ).toContain("idempotencyKey");
    }
    expect(auditRows(t)).toEqual([]);
  });

  it("cancels at period end, extends a trial, and grants a complimentary period", async () => {
    const t = await createTestApp();
    const device = t.device();
    await device.api.signup({
      body: { email: "trial@example.test", password: "correct horse battery" },
    });
    const started = await device.api.startCheckout({ body: { planId: "standard" } });
    await t.ports.payments.confirmSetup(started.clientSecret ?? "", "mastercard");
    await device.api.confirmCheckout({ params: { id: started.id } });
    await t.queue.drain();
    await device.api.getCheckout({ params: { id: started.id } });
    const accountId = await accountIdOf(device);
    const staff = staffClient(t, ["support", "billing"]);
    const before = await staff.getMember({ params: { accountId } });
    expect(before.membership.status).toBe("trialing");
    const extended = await staff.extendMemberTrial({
      params: { accountId },
      body: { days: 7, reason: "Service outage", idempotencyKey: KEY },
    });
    expect(Date.parse(extended.trialEndsAt ?? "")).toBe(
      Date.parse(before.membership.trialEndsAt ?? "") + 7 * 86_400_000,
    );
    // A retry does not extend it twice.
    const retried = await staff.extendMemberTrial({
      params: { accountId },
      body: { days: 7, reason: "Service outage", idempotencyKey: KEY },
    });
    expect(retried.trialEndsAt).toBe(extended.trialEndsAt);
    expect((await staff.getMember({ params: { accountId } })).membership.trialEndsAt).toBe(
      extended.trialEndsAt,
    );
    const free = await staff.grantComplimentaryPeriod({
      params: { accountId },
      body: { days: 30, reason: "Retention offer", idempotencyKey: `${KEY.slice(0, -1)}3` },
    });
    expect(Date.parse(free.trialEndsAt ?? "")).toBeGreaterThan(
      Date.parse(extended.trialEndsAt ?? ""),
    );
    const canceled = await staff.cancelMemberSubscription({
      params: { accountId },
      body: { when: "period_end", reason: "Member asked", idempotencyKey: `${KEY.slice(0, -1)}4` },
    });
    expect(canceled.cancelAtPeriodEnd).toBe(true);
    expect(
      auditRows(t)
        .filter((row) => row.action.startsWith("billing."))
        .map((row) => [row.action, row.outcome]),
    ).toEqual([
      ["billing.trial_extended", "succeeded"],
      ["billing.complimentary_period_granted", "succeeded"],
      ["billing.subscription_canceled", "succeeded"],
    ]);
  });

  it("lists plans, sets a price with its previous amount in the entry, and syncs", async () => {
    const t = await createTestApp();
    const staff = staffClient(t, ["billing"]);
    const plans = await staff.listAdminPlans();
    expect(plans.items.map((plan) => plan.id)).toEqual(["basic", "standard", "premium"]);
    const plan = await staff.setPlanPrice({
      params: { planId: "basic", currency: "USD" },
      body: { amountMinor: 899, reason: "Price review 2027" },
    });
    expect(plan.prices.find((price) => price.currency === "USD")?.amountMinor).toBe(899);
    const synced = await staff.syncPlans({ body: { reason: "After the price review" } });
    expect(synced.provider).toBeTypeOf("string");
    const [price] = auditRows(t).filter((row) => row.action === "billing.price_set");
    expect(price).toMatchObject({
      target: { type: "plan_price", id: "basic.USD" },
      before: { request: { amountMinor: 899 }, state: { amountMinor: 799, active: true } },
      after: { amountMinor: 899 },
      outcome: "succeeded",
    });
  });
});

describe("member privacy", () => {
  it("shows consent and requests without the export's download link, and audits the read", async () => {
    const t = await createTestApp({ config: { WEBFLIX_CONSENT_MODE: "opt-out" } });
    const { device } = await onboard(t, { email: "privacy@example.test" });
    const accountId = await accountIdOf(device);
    const store = (t.deps.repos as unknown as { store: MemoryStore }).store;
    for (const record of store.sessions.values()) {
      if (record.accountId === accountId) {
        await t.deps.repos.identity.elevateSession(
          record.id,
          accountId,
          t.clock.now() + 300_000,
          t.clock.now(),
        );
      }
    }
    await device.api.requestDataExport();
    await t.queue.drain();
    const own = await device.api.listPrivacyRequests();
    expect(own.items[0]?.downloadUrl).toMatch(/^\/api\/v1\/privacy\/exports\//);
    const response = await rawStaff(t, ["support"], "GET", `/members/${accountId}/privacy`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("/privacy/exports/");
    expect(text).not.toContain("token=");
    const view = JSON.parse(text);
    expect(view.requests).toEqual([
      expect.objectContaining({ kind: "export", status: "completed", downloadUrl: null }),
    ]);
    expect(auditRows(t).at(-1)).toMatchObject({
      action: "member.privacy_viewed",
      target: { type: "member", id: accountId },
    });
    expect((await rawStaff(t, ["support"], "GET", "/members/nobody/privacy")).status).toBe(404);
  });

  it("records a consent answer given to support, and cancels a scheduled deletion", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "leaving@example.test" });
    const accountId = await accountIdOf(device);
    const staff = staffClient(t, ["support"]);
    const consent = await staff.setMemberConsent({
      params: { accountId },
      body: { purpose: "personalisation", granted: false, reason: "Member asked by phone" },
    });
    expect(consent.purposes.personalisation).toMatchObject({ granted: false, source: "support" });
    const none = await rawStaff(t, ["support"], "DELETE", `/members/${accountId}/deletion`, {
      reason: "Member changed their mind",
    });
    expect(none.status).toBe(404);
    const store = (t.deps.repos as unknown as { store: MemoryStore }).store;
    for (const record of store.sessions.values()) {
      if (record.accountId === accountId) {
        await t.deps.repos.identity.elevateSession(
          record.id,
          accountId,
          t.clock.now() + 300_000,
          t.clock.now(),
        );
      }
    }
    await device.api.requestAccountDeletion();
    await staff.cancelMemberDeletion({ params: { accountId }, body: { reason: "Changed mind" } });
    const requests = await device.api.listPrivacyRequests();
    expect(requests.items[0]?.status).toBe("canceled");
    expect(auditRows(t).map((row) => [row.action, row.outcome])).toEqual([
      ["privacy.consent_recorded", "succeeded"],
      ["privacy.deletion_canceled", "failed"],
      ["privacy.deletion_canceled", "succeeded"],
    ]);
  });

  it("gives the operator the keys to erase and records the compaction's confirmation", async () => {
    const t = await createTestApp();
    const staff = staffClient(t, ["admin"]);
    expect(await staff.listPendingErasures({ query: {} })).toEqual({ subjectKeys: [] });
    await staff.confirmErasures({
      body: { subjectKeys: ["k3Jx9QvT0bYzA1c2D3e4F5"], reason: "Compaction 2026-11-22" },
    });
    expect(auditRows(t)[0]).toMatchObject({
      action: "privacy.erasures_confirmed",
      outcome: "succeeded",
      before: { request: { subjectKeys: ["k3Jx9QvT0bYzA1c2D3e4F5"] } },
    });
  });

  it("lists a batch-mode export for the pipeline and finishes it from the job's results; an unknown request changes nothing", async () => {
    const t = await createTestApp({
      config: { WEBFLIX_EXPORT_EVENTS: "batch", WEBFLIX_CONSENT_MODE: "opt-out" },
    });
    const { device } = await onboard(t, { email: "batch-export@example.test" });
    const accountId = await accountIdOf(device);
    const ingested = await device.request(`${API_BASE_PATH}/events`, {
      method: "POST",
      headers: { "X-Webflix-Client": "web", "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          makeClientEventInput("title.open", {
            eventId: "0193a1d2-7c4e-7a10-8f00-00000000ba01",
            deviceId: "dev-batch-export",
            sessionSeq: 1,
            payload: { titleId: "t-orbit" },
          }),
        ],
      }),
    });
    expect(ingested.status).toBe(202);
    await t.queue.drain();
    // The export's window ends at the request: received before it.
    t.clock.advance(1000);
    const store = (t.deps.repos as unknown as { store: MemoryStore }).store;
    for (const record of store.sessions.values()) {
      if (record.accountId === accountId) {
        await t.deps.repos.identity.elevateSession(
          record.id,
          accountId,
          t.clock.now() + 300_000,
          t.clock.now(),
        );
      }
    }
    const request = await device.api.requestDataExport();
    await t.queue.drain();

    const staff = staffClient(t, ["admin"]);
    // Answered as the events area gives it: `{ requests: [...] }`, the shape the pipeline reads.
    const pending = await staff.listPendingExports({ query: { limit: 10 } });
    expect(pending.requests).toEqual([
      expect.objectContaining({ requestId: request.id, to: request.requestedAt }),
    ]);
    const [listed] = pending.requests;
    if (!listed) throw new Error("not listed");

    const document = (result: Record<string, unknown>) => ({
      format: "webflix.export-events-results" as const,
      formatVersion: 1 as const,
      generatedAt: new Date(t.clock.now()).toISOString(),
      results: [{ from: listed.from, to: listed.to, ...result }] as never,
      reason: "export-events run",
    });

    // A result for a request the product never had: nothing changes.
    await staff.recordExportResults({
      body: document({ requestId: "unknown-request-1", status: "deferred" }),
    });
    expect((await staff.listPendingExports({ query: {} })).requests).toEqual([listed]);
    expect((await device.api.listPrivacyRequests()).items[0]).toMatchObject({
      status: "processing",
      downloadUrl: null,
    });

    // What export-events writes: the account's events, gzip NDJSON, and its manifest.
    const theirs = t.ports.eventSink
      .events()
      .filter((event) => event.subject.account === listed.accountKey);
    expect(theirs.length).toBeGreaterThan(0);
    const bytes = await encodeLakeObject(theirs);
    const file = await t.ports.eventSink.putDocument(
      `export-events/${request.id}/events.ndjson.gz`,
      bytes,
    );
    const manifest = await t.ports.eventSink.putDocument(
      `export-events/${request.id}/manifest.json`,
      new TextEncoder().encode("{}"),
    );
    const sha256 = hexEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    await staff.recordExportResults({
      body: document({
        requestId: request.id,
        status: "complete",
        events: theirs.length,
        file,
        manifest,
        bytes: bytes.byteLength,
        sha256,
      }),
    });

    // The member sees the finished export, with the pipeline's events in it.
    const [done] = (await device.api.listPrivacyRequests()).items;
    expect(done).toMatchObject({ id: request.id, status: "completed" });
    const download = await device.request(done?.downloadUrl ?? "");
    expect(download.status).toBe(200);
    const exported = (await download.json()) as { events: { eventId: string }[] };
    expect(exported.events.map((event) => event.eventId).sort()).toEqual(
      theirs.map((event) => event.eventId).sort(),
    );
    expect((await staff.listPendingExports({ query: {} })).requests).toEqual([]);

    // Each call has its entry; neither keeps anything resembling a download link.
    const entries = auditRows(t).filter((row) => row.action === "privacy.export_events_recorded");
    expect(entries.map((row) => [row.outcome, row.after])).toEqual([
      ["succeeded", { completed: [], erased: [], kept: [], ignored: ["unknown-request-1"] }],
      ["succeeded", { completed: [request.id], erased: [], kept: [], ignored: [] }],
    ]);
    expect(entries[1]?.before).toMatchObject({
      request: { results: [{ requestId: request.id, status: "complete", file, sha256 }] },
    });
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("/api/v1/privacy/exports/");
    expect(logged).not.toContain("token=");
  });

  it("refuses export results that point anywhere but the request's own documents, before anything runs", async () => {
    const t = await createTestApp();
    const requestId = "0193f7d2-cccc-7ddd-8eee-000000000001";
    const complete = {
      requestId,
      status: "complete",
      from: "2025-10-22T09:00:00.000Z",
      to: "2026-11-22T09:00:00.000Z",
      events: 3,
      file: `privacy/export-events/${requestId}/events.ndjson.gz`,
      manifest: `privacy/export-events/${requestId}/manifest.json`,
      bytes: 120,
      sha256: "a".repeat(64),
    };
    const document = (results: unknown[]) => ({
      format: "webflix.export-events-results",
      formatVersion: 1,
      generatedAt: "2026-11-22T09:20:00.000Z",
      results,
      reason: "export-events run",
    });
    const cases: [unknown, string][] = [
      [{ ...complete, file: "privacy/exports/someone-else/document.json" }, "results.0.file"],
      [
        { ...complete, file: "privacy/export-events/other-request/events.ndjson.gz" },
        "results.0.file",
      ],
      [
        { ...complete, manifest: `privacy/export-events/${requestId}/../x.json` },
        "results.0.manifest",
      ],
      [{ ...complete, file: undefined }, "results.0.status"],
      [{ ...complete, requestId: "../escape" }, "results.0.requestId"],
    ];
    for (const [result, path] of cases) {
      const response = await rawStaff(
        t,
        ["admin"],
        "POST",
        "/system/privacy/exports/results",
        document([result]),
      );
      expect(response.status, path).toBe(400);
      const problem = await response.json();
      expect(
        problem.issues.map((issue: { path: string }) => issue.path),
        path,
      ).toContain(path);
    }
    // Refused by validation: nothing was audited, nothing ran.
    expect(auditRows(t)).toEqual([]);
  });
});

describe("editorial and experiments (their areas write the entry with the change)", () => {
  it("pins a billboard and curates a row, each with one entry; a refused change gets one too", async () => {
    const t = await createTestApp();
    const staff = staffClient(t, ["content"]);
    const billboard = await staff.setBillboard({
      params: { view: "home" },
      body: { titleIds: ["t-orbit"], reason: "Holiday campaign" },
    });
    expect(billboard.titleIds).toEqual(["t-orbit"]);
    expect((await staff.getBillboard({ params: { view: "home" } })).titleIds).toEqual(["t-orbit"]);
    const collection = await staff.createCollection({
      body: {
        name: "Staff picks",
        description: null,
        view: "home",
        position: 3,
        titleIds: ["t-orbit"],
        status: "published",
        reason: "Weekly picks",
      },
    });
    const refused = await rawStaff(t, ["content"], "PUT", "/titles/t-missing/availability", {
      available: false,
      reason: "Licence ended",
    });
    expect(refused.status).toBe(404);
    const log = await staffClient(t, ["admin"]).listAuditLog({ query: {} });
    expect(
      log.items.map((entry) => [entry.action, entry.outcome, entry.target.id]).reverse(),
    ).toEqual([
      ["editorial.billboard_set", "succeeded", "home"],
      ["editorial.collection_create", "succeeded", collection.id],
      ["editorial.availability_set", "failed", "t-missing"],
    ]);
    // The member-facing browse shows the curated row.
    const { device } = await onboard(t, { email: "browser@example.test" });
    const page = await device.api.getBrowse({ query: { view: "home" } });
    expect(page.rows.some((row) => row.title === "Staff picks")).toBe(true);
  });

  it("runs the experiment lifecycle with the experiments role", async () => {
    const t = await createTestApp();
    const staff = staffClient(t, ["experiments"]);
    const created = await rawStaff(t, ["experiments"], "POST", "/experiments", {
      key: "home.billboard-motion",
      name: "Billboard motion",
      description: "Motion art on the billboard",
      unit: "profile",
      layer: "home",
      allocation: { start: 0, end: 1000 },
      targeting: { percentage: 100, plans: [], countries: [], audience: "all" },
      variants: [
        { name: "control", weight: 50 },
        { name: "motion", weight: 50 },
      ],
      control: "control",
      primaryMetric: "qualified_plays",
      secondaryMetrics: [],
      alpha: 0.05,
      power: 0.8,
      minimumDetectableEffect: 0.02,
      startsAt: null,
      endsAt: null,
      srmThreshold: 0.001,
      reason: "Pre-registration",
    });
    if (created.status !== 201) {
      // The design vocabulary is the experiments area's: show what it refused.
      throw new Error(`create: ${created.status} ${await created.text()}`);
    }
    const started = await staff.setExperimentStatus({
      params: { key: "home.billboard-motion" },
      body: { status: "running", reason: "Review passed" },
    });
    expect(started.status).toBe("running");
    const conflict = await rawStaff(
      t,
      ["experiments"],
      "PUT",
      "/experiments/home.billboard-motion/status",
      {
        status: "draft",
        reason: "Back to draft",
      },
    );
    expect((await conflict.json()).code).toBe("experiment_conflict");
    expect(
      (await staff.getExperimentResults({ params: { key: "home.billboard-motion" } })).report,
    ).toBeNull();
    const log = await staffClient(t, ["admin"]).listAuditLog({
      query: { targetType: "experiment" },
    });
    expect(log.items.map((entry) => [entry.action, entry.outcome]).reverse()).toEqual([
      ["experiment.create", "succeeded"],
      ["experiment.status", "succeeded"],
      ["experiment.status", "failed"],
    ]);
  });
});

describe("system", () => {
  it("reports health, records dead letters in the shared store, replays each once", async () => {
    const t = await createTestApp();
    const staff = staffClient(t, ["admin"]);
    await t.queue.publish({ type: "no.such-job", payload: { email: "secret@example.test" } });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await t.queue.drain();
      t.clock.advance(3_600_000);
    }
    expect(t.queue.deadLetters).toHaveLength(1);
    const health = await staff.getSystemHealth();
    expect(health.jobs).toEqual({ depth: null, deadLetters: 1 });
    expect(health.dependencies.map((dependency) => [dependency.name, dependency.up])).toEqual([
      ["database", true],
      ["cache", true],
      ["recommendation-store", true],
    ]);
    const response = await rawStaff(t, ["admin"], "GET", "/system/dead-letters");
    const text = await response.text();
    // Listed without its payload (it can hold personal data).
    expect(text).not.toContain("secret@example.test");
    const page = JSON.parse(text);
    expect(page.items).toEqual([
      expect.objectContaining({ jobType: "no.such-job", attempts: 5, replayedAt: null }),
    ]);
    const id = page.items[0].id;
    const replayed = await staff.replayDeadLetter({
      params: { id },
      body: { reason: "Bug fixed" },
    });
    expect(replayed.replayedAt).not.toBeNull();
    expect(t.queue.size).toBe(1);
    const twice = await rawStaff(t, ["admin"], "POST", `/system/dead-letters/${id}/replay`, {
      reason: "Again",
    });
    expect((await twice.json()).code).toBe("staff_action_conflict");
    expect(auditRows(t).map((row) => [row.action, row.outcome])).toEqual([
      ["system.dead_letter_replayed", "succeeded"],
      ["system.dead_letter_replayed", "failed"],
    ]);
  });

  it("reports the served model, queues an import, refuses a rollback without a previous run", async () => {
    const t = await createTestApp();
    const staff = staffClient(t, ["admin"]);
    expect(await staff.getRecommendationStatus()).toEqual({ activeModel: null, lastImport: null });
    await staff.importRecommendations({ body: { reason: "New run published" } });
    expect(t.queue.size).toBe(1);
    const rollback = await rawStaff(t, ["admin"], "POST", "/system/recommendations/rollback", {
      reason: "Bad run",
    });
    expect(rollback.status).toBe(404);
    expect(auditRows(t).map((row) => [row.action, row.outcome, row.before])).toEqual([
      ["system.recommendations_import_requested", "succeeded", { request: null }],
      [
        "system.recommendations_rolled_back",
        "failed",
        { request: null, state: { activeRun: null } },
      ],
    ]);
  });

  it("pages the audit log newest first and filters it", async () => {
    const t = await createTestApp();
    const staff = staffClient(t, ["admin"]);
    for (const view of ["home", "series", "movies"] as const) {
      await staff.setBillboard({
        params: { view },
        body: { titleIds: [], reason: `Reset ${view}` },
      });
      t.clock.advance(1000);
    }
    const first = await staff.listAuditLog({ query: { limit: 2 } });
    expect(first.items.map((entry) => entry.target.id)).toEqual(["movies", "series"]);
    const next = await staff.listAuditLog({ query: { limit: 2, cursor: first.nextCursor ?? "" } });
    expect(next.items.map((entry) => entry.target.id)).toEqual(["home"]);
    expect(next.nextCursor).toBeNull();
    const bad = await rawStaff(t, ["admin"], "GET", "/audit?cursor=nonsense");
    expect(bad.status).toBe(400);
    // The personalisation area wrote these entries in its own batches; the staff API none.
    expect(auditRows(t)).toEqual([]);
  });
});
