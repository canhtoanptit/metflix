/**
 * Billing actions from a member's page, and what makes them safe: one idempotency key per form,
 * kept through retries, so pressing twice or checking again after no answer refunds once; an
 * unclear outcome is shown as unknown and leads to the audit log instead of a second attempt;
 * a refusal changes nothing and the corrected form gets a new key.
 */
import type { Page, Request } from "@playwright/test";
import {
  createMember,
  type Member,
  paidMember,
  signInToConsole,
  startTrial,
} from "./admin-helpers.ts";
import { expect, test } from "./fixtures.ts";

const REFUNDS = /\/api\/admin\/v1\/members\/[^/]+\/refunds$/;

function refundPosts(page: Page): Request[] {
  const posts: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && REFUNDS.test(new URL(request.url()).pathname))
      posts.push(request);
  });
  return posts;
}

const keyOf = (request: Request) =>
  (request.postDataJSON() as { idempotencyKey: string }).idempotencyKey;

async function refunded(member: Member, invoiceId: string): Promise<number> {
  const page = (await (await member.api.get("/api/v1/billing/invoices")).json()) as {
    items: { id: string; amountRefunded: { amountMinor: number } }[];
  };
  return page.items.find((invoice) => invoice.id === invoiceId)?.amountRefunded.amountMinor ?? -1;
}

async function openPartialRefund(page: Page, invoiceNumber: string, amountMajor: string) {
  await page.getByRole("button", { name: `Refund invoice ${invoiceNumber}` }).click();
  const dialog = page.getByRole("dialog", { name: `Refund invoice ${invoiceNumber}` });
  await dialog.getByRole("radio", { name: "Part of it" }).check();
  await dialog.getByLabel(/Amount to refund/).fill(amountMajor);
  await dialog.getByLabel("Reason").fill("Goodwill refund for a playback outage (ticket 991)");
  return dialog;
}

test("a partial refund pressed twice refunds once", async ({ page }) => {
  const member = await paidMember("refund-twice");
  const { invoice } = member;
  const part = Math.floor(invoice.amountPaid.amountMinor / 3);
  const posts = refundPosts(page);
  await signInToConsole(page, "staff-admin", `members/${member.accountId}`);
  const dialog = await openPartialRefund(
    page,
    invoice.number ?? invoice.id,
    (part / 100).toFixed(2),
  );
  const confirm = dialog.getByRole("button", { name: /^Refund / });
  await confirm.dblclick();
  await expect(dialog.getByRole("heading", { name: "Done" })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText(/^Refunded /)).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(await refunded(member, invoice.id)).toBe(part);
});

test("no answer, then check again: the same key, the first refund's answer, refunded once", async ({
  page,
}) => {
  const member = await paidMember("refund-no-answer");
  const { invoice } = member;
  const part = Math.floor(invoice.amountPaid.amountMinor / 4);
  const posts = refundPosts(page);
  // The first send reaches the server and the refund is made, but the answer never arrives.
  let first = true;
  await page.route(REFUNDS, async (route) => {
    if (!first) return route.continue();
    first = false;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await signInToConsole(page, "staff-admin", `members/${member.accountId}`);
  const dialog = await openPartialRefund(
    page,
    invoice.number ?? invoice.id,
    (part / 100).toFixed(2),
  );
  await dialog.getByRole("button", { name: /^Refund / }).click();
  await expect(dialog.getByRole("heading", { name: "No answer from the server" })).toBeVisible();
  await expect(
    dialog.getByText("can't refund twice").or(dialog.getByText("instead of doing it twice")),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect(dialog.getByRole("heading", { name: "Done" })).toBeVisible({ timeout: 30_000 });
  expect(posts).toHaveLength(2);
  expect(keyOf(posts[1] as Request)).toBe(keyOf(posts[0] as Request));
  expect(await refunded(member, invoice.id)).toBe(part);
});

test("an unknown outcome is shown as unknown, leads to the audit log, and survives closing", async ({
  page,
}) => {
  const member = await paidMember("refund-unknown");
  const { invoice } = member;
  const posts = refundPosts(page);
  await page.route(REFUNDS, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "urn:webflix:problem:service_unavailable",
        title: "Service temporarily unavailable",
        status: 503,
        code: "service_unavailable",
        detail: "The payment provider is not answering. Try again in a moment.",
        requestId: "e2e-unknown-outcome",
      }),
    }),
  );
  await signInToConsole(page, "staff-admin", `members/${member.accountId}`);
  const number = invoice.number ?? invoice.id;
  const dialog = await openPartialRefund(page, number, "1.00");
  await dialog.getByRole("button", { name: /^Refund / }).click();
  await expect(dialog.getByRole("heading", { name: "Outcome unknown" })).toBeVisible();
  await expect(dialog.getByText("can't say whether the change was made")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Check again" })).toHaveCount(0);
  // The way on is the entry the request wrote, found by the X-Request-Id the console sent.
  const sentRequestId = (posts[0] as Request).headers()["x-request-id"] ?? "";
  expect(sentRequestId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(dialog.getByRole("link", { name: "Open its audit entry" })).toHaveAttribute(
    "href",
    new RegExp(`/admin/operations/audit\\?requestId=${sentRequestId}$`),
  );
  // Closing does not forget it: the same action opens on where it stands, not a fresh form.
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: `Refund invoice ${number}` }).click();
  await expect(dialog.getByRole("heading", { name: "Outcome unknown" })).toBeVisible();
  // Only after the staff member says it didn't happen does a new attempt (a new key) begin.
  await dialog.getByRole("button", { name: "Start a new attempt" }).click();
  await dialog.getByLabel("Reason").fill("Checked: no refund at the provider");
  await dialog.getByRole("button", { name: /^Refund / }).click();
  await expect(dialog.getByRole("heading", { name: "Outcome unknown" })).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(keyOf(posts[1] as Request)).not.toBe(keyOf(posts[0] as Request));
  expect(await refunded(member, invoice.id)).toBe(0);
});

test("a refusal changes nothing, keeps the form, and the corrected form gets a new key", async ({
  page,
}) => {
  const member = await paidMember("refund-refused");
  const { invoice } = member;
  const posts = refundPosts(page);
  let refuse = true;
  await page.route(REFUNDS, (route) => {
    if (!refuse) return route.continue();
    refuse = false;
    return route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "urn:webflix:problem:checkout_state_conflict",
        title: "This checkout can't do that right now",
        status: 409,
        code: "checkout_state_conflict",
        detail: "Nothing to refund for that amount on this invoice.",
      }),
    });
  });
  await signInToConsole(page, "staff-admin", `members/${member.accountId}`);
  const dialog = await openPartialRefund(page, invoice.number ?? invoice.id, "1.00");
  await dialog.getByRole("button", { name: /^Refund / }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Nothing was changed." })).toBeVisible();
  await dialog.getByRole("button", { name: /^Refund / }).click();
  await expect(dialog.getByRole("heading", { name: "Done" })).toBeVisible({ timeout: 30_000 });
  expect(posts).toHaveLength(2);
  expect(keyOf(posts[1] as Request)).not.toBe(keyOf(posts[0] as Request));
  expect(await refunded(member, invoice.id)).toBe(100);
});

test("a trial is extended, free time given, and the membership cancelled at period end", async ({
  page,
}) => {
  const member = await createMember("trial-actions");
  const trial = await startTrial(member);
  expect(trial.status).toBe("trialing");
  await signInToConsole(page, "staff-admin", `members/${member.accountId}`);

  await page.getByRole("button", { name: "Extend trial" }).click();
  const extend = page.getByRole("dialog", { name: "Extend the trial" });
  await extend.getByLabel("Days to add").fill("31");
  await extend.getByLabel("Reason").fill("Onboarding issue, extend a week");
  await extend.getByRole("button", { name: /^Extend/ }).click();
  await expect(extend.getByText("Enter a whole number of days from 1 to 30.")).toBeVisible();
  await extend.getByLabel("Days to add").fill("7");
  await extend.getByRole("button", { name: "Extend by 7 days" }).click();
  await expect(extend.getByRole("heading", { name: "Done" })).toBeVisible({ timeout: 30_000 });
  await extend.getByRole("button", { name: "Close" }).click();
  const after = (await (await member.api.get("/api/v1/account")).json()) as {
    membership: { trialEndsAt: string; cancelAtPeriodEnd: boolean; status: string };
  };
  expect(Date.parse(after.membership.trialEndsAt) - Date.parse(trial.trialEndsAt ?? "")).toBe(
    7 * 86_400_000,
  );

  await page.getByRole("button", { name: "Give free time" }).click();
  const free = page.getByRole("dialog", { name: "Give free time" });
  await free.getByLabel("Free days").fill("14");
  await free.getByLabel("Reason").fill("Service credit for the outage");
  await free.getByRole("button", { name: "Give 14 free days" }).click();
  await expect(free.getByRole("heading", { name: "Done" })).toBeVisible({ timeout: 30_000 });
  await free.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Cancel membership" }).click();
  const cancel = page.getByRole("dialog", { name: "Cancel the membership" });
  await expect(cancel.getByRole("radio", { name: /At the end of the period/ })).toBeChecked();
  await cancel.getByLabel("Reason").fill("Member asked to cancel; keeps access until the end");
  await cancel.getByRole("button", { name: "Cancel at period end" }).click();
  await expect(cancel.getByRole("heading", { name: "Done" })).toBeVisible({ timeout: 30_000 });
  const cancelled = (await (await member.api.get("/api/v1/account")).json()) as {
    membership: { cancelAtPeriodEnd: boolean };
  };
  expect(cancelled.membership.cancelAtPeriodEnd).toBe(true);
});
