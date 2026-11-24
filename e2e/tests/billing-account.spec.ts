import { CLIENT_HEADERS } from "./api.ts";
import {
  addProfile,
  advancePast,
  aMovie,
  createBareAccount,
  expectCardDataOnlyAtProvider,
  freshCard,
  membershipOf,
  RENEWAL_SETTLE_SEC,
  requireFakeProvider,
  scheduleDeletion,
  spentCard,
  subscribe,
  tabTo,
  watchCardData,
} from "./billing-support.ts";
import { expect, test } from "./fixtures.ts";
import { expectAccessible } from "./member-support.ts";

/**
 * Membership in Account against the real API and the fake provider (docs/BLUEPRINT-M2.md §5):
 * what the member has, plan changes charged exactly as previewed, cancel and keep, the card
 * replaced in the provider's form, a failed renewal through grace and hold to recovery, and a
 * restart without a second trial. Time passes on the account's own test clock, never by sleeping.
 */

test.beforeEach(async ({ page }) => {
  await requireFakeProvider(page.context().request);
});

test("a trial: what the member has, cancelling it (watch until it ends, no charge) and keeping it", async ({
  page,
}) => {
  const request = page.context().request;
  await createBareAccount(request, "billing-trial");
  await subscribe(request, { planId: "standard", card: freshCard() });
  await addProfile(request);
  const { trialEndsAt } = await membershipOf(request);

  await page.goto("/account");
  const panel = page.getByRole("region", { name: "Membership" });
  await expect(panel.getByTestId("membership-status")).toHaveText(/free trial/i);
  await expect(panel).toContainText("First payment");
  await expect(panel).toContainText("$12.99 on");
  await expectAccessible(page);
  await panel.getByRole("link", { name: "Manage membership" }).click();
  await expect(page.getByRole("heading", { name: "Membership", level: 1 })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: "Cancel membership" }).click();
  await expect(page.getByRole("heading", { name: "Cancel your free trial?" })).toBeVisible();
  await expect(page.getByText("You won't be charged at all")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Finish cancellation" }).click();
  await expect(page).toHaveURL(/\/account\/membership$/);
  // Focus lands on the destination's heading, and the toast says what the page says.
  await expect(page.getByRole("heading", { name: "Membership", level: 1 })).toBeFocused();
  await expect(page.getByText(/Your free trial ends on/)).toHaveCount(2);
  const cancelled = await membershipOf(request);
  expect(cancelled.status).toBe("trialing");
  expect(cancelled.cancelAtPeriodEnd).toBe(true);
  expect(cancelled.trialEndsAt).toBe(trialEndsAt);

  // The profile gate reminds too; keeping it is one click on the membership page.
  await page.goto("/profiles");
  await expect(page.getByText(/Your free trial ends on/)).toBeVisible();
  await page.goto("/account/membership");
  await page.getByRole("button", { name: "Keep my membership" }).click();
  await expect(page.getByText(/Your free trial ends on/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your membership" })).toBeFocused();
  await expect(page.getByText("Your membership will continue")).toHaveCount(1);
  expect((await membershipOf(request)).cancelAtPeriodEnd).toBe(false);

  // The trial's $0 invoice is the free trial, not a payment (UX review 3.9).
  await page.goto("/account/membership/invoices");
  const trialRow = page.getByRole("main").getByRole("listitem").last();
  await expect(trialRow).toContainText("Free trial");
  await expect(trialRow).not.toContainText("Paid");
});

test("plan changes: an upgrade is charged exactly as previewed, a downgrade credits what it said", async ({
  page,
}) => {
  const request = page.context().request;
  const card = await spentCard(request);
  await createBareAccount(request, "billing-plan");
  await subscribe(request, { planId: "standard", card });
  await addProfile(request);

  await page.goto("/account/membership/plan");
  await page.getByRole("radio", { name: /Premium/ }).click();
  const preview = page.getByRole("status", { name: "Switching to Premium" });
  await expect(preview.getByText("Charged today")).toBeVisible();
  await expectAccessible(page);
  const pay = page.getByRole("button", { name: /^Pay \$\d+\.\d\d and switch$/ });
  const label = (await pay.textContent()) ?? "";
  const amount = label.match(/\$(\d+\.\d\d)/)?.[1];
  expect(amount, `the button names the previewed charge (${label})`).toBeTruthy();
  await expect(preview).toContainText(`$${amount}`);
  await expect(page.getByRole("link", { name: "Keep Standard" })).toBeVisible();
  await pay.click();
  await expect(page).toHaveURL(/\/account\/membership$/);
  await expect(page.getByText("You're now on Premium").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Membership", level: 1 })).toBeFocused();
  // The provider invoiced exactly the previewed amount.
  const invoices = (await (await request.get("/api/v1/billing/invoices")).json()) as {
    items: Array<{ total: { amountMinor: number } }>;
  };
  expect(invoices.items[0]?.total.amountMinor).toBe(Math.round(Number(amount) * 100));
  expect((await membershipOf(request)).planId).toBe("premium");

  // A downgrade: nothing charged today, the credit and the next payment said before confirming.
  await page.goto("/account/membership/plan");
  await page.getByRole("radio", { name: /Basic/ }).click();
  const down = page.getByRole("status", { name: "Switching to Basic" });
  // One Webflix sentence for today and one for the next payment, each with its reason; the
  // provider's own lines are folded away (UX review 2.3).
  await expect(down).toContainText(/Nothing to pay today\. The time left on Premium covers Basic/);
  await expect(down).toContainText(
    /Your \$\d+\.\d\d credit makes your next payment \$\d+\.\d\d on .+, then \$7\.99 a month\./,
  );
  await expect(down.getByText("Credit kept for your next payments")).toBeHidden();
  await down.getByText("How this is worked out").click();
  await expect(down.getByText("Credit kept for your next payments")).toBeVisible();
  await expect(down).toContainText("the most recent streams will stop");
  const nextPayment =
    (await down
      .getByText(/^Next payment, /)
      .locator("..")
      .textContent()) ?? "";
  const nextAmount = nextPayment.match(/\$\d+\.\d\d/)?.[0];
  await page.getByRole("button", { name: "Switch to Basic" }).click();
  await expect(page.getByText("You're now on Basic").first()).toBeVisible();
  expect((await membershipOf(request)).planId).toBe("basic");
  // The membership's next payment is the one the preview showed (the credit applied).
  expect(nextAmount, nextPayment).toBeTruthy();
  const membership = page.getByRole("region", { name: "Your membership" });
  await expect(membership).toContainText(`Next payment${nextAmount} on`);
  await expect(membership).toContainText(/\$7\.99 less your \$\d+\.\d\d credit/);
  // Billing history labels the credit as a credit, not a payment.
  await page.goto("/account/membership/invoices");
  const credit = page.getByRole("main").getByRole("listitem").first();
  await expect(credit).toContainText(/\$\d+\.\d\d credit/);
  await expect(credit).toContainText("Credited");
  await expect(credit).not.toContainText("Paid");
});

test("the card is replaced in the provider's form, never on Webflix's page", async ({ page }) => {
  const request = page.context().request;
  await createBareAccount(request, "billing-card");
  await subscribe(request, { planId: "basic", card: freshCard() });
  await addProfile(request);
  const cardData = watchCardData(page);

  await page.goto("/account/membership/payment");
  await expect(page.getByText("Visa •••• 4242")).toBeVisible();
  await expectAccessible(page);
  // One click to the provider's page (UX review 3.14).
  await page.getByRole("button", { name: "Replace card" }).click();
  await expect(page).toHaveURL(/\/_pay\/form\?/);
  await page.getByLabel(/type a test card number/i).fill(freshCard("mastercard"));
  await page.getByRole("button", { name: "Save card" }).click();
  await expect(page.getByText("Your card has been updated")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Mastercard •••• 4444")).toBeVisible();

  // A refused card comes back with its reason; returning without one says so.
  await page.getByRole("button", { name: "Replace card" }).click();
  await page.getByLabel(/type a test card number/i).fill("4000000000000069");
  await page.getByRole("button", { name: "Save card" }).click();
  await expect(page.getByText("Your card has expired")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Your card on file hasn't changed/)).toBeVisible();
  await page.getByRole("button", { name: "Replace card" }).click();
  await page.getByRole("link", { name: "Cancel and return" }).click();
  await expect(page.getByText("No new card was added")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Mastercard •••• 4444")).toBeVisible();
  expectCardDataOnlyAtProvider(cardData());
});

test("a failed renewal: still watching in grace with one clear ask, then on hold, then recovered with a new card", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  await createBareAccount(request, "billing-dunning");
  // Saved fine, declined whenever it is charged later.
  await subscribe(request, { planId: "basic", card: freshCard("charge-declined") });
  await addProfile(request);
  const movie = await aMovie(request);
  const trial = await membershipOf(request);
  await advancePast(request, trial.trialEndsAt ?? "", RENEWAL_SETTLE_SEC);
  const pastDue = await membershipOf(request);
  expect(pastDue.status).toBe("past_due");

  // Grace: still watching, and the ask is everywhere the member passes.
  await page.goto("/account/membership");
  await expect(page.getByText("We couldn't take your last payment")).toBeVisible();
  await expect(page.getByText(/You can keep watching until/)).toBeVisible();
  await expectAccessible(page);
  await page.goto("/profiles");
  await expect(page.getByText("We couldn't take your last payment")).toBeVisible();

  // Grace runs out: on hold, and playback offers the way back instead of an error.
  await advancePast(request, pastDue.graceEndsAt ?? "", 60);
  expect((await membershipOf(request)).status).toBe("suspended");
  await page.goto(`/watch/${movie.id}`);
  await expect(page.getByRole("heading", { name: "Your membership is on hold" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Update payment method" }).click();
  await expect(page).toHaveURL(/\/account\/membership\/payment/);
  await page.getByRole("button", { name: "Replace card" }).click();
  await page.getByLabel(/type a test card number/i).fill(freshCard("visa"));
  await page.getByRole("button", { name: "Save card" }).click();
  await expect(page.getByText("Your payment went through")).toBeVisible({ timeout: 30_000 });
  expect((await membershipOf(request)).status).toBe("active");

  // Watching again.
  const start = await request.post("/api/v1/playback/sessions", {
    headers: CLIENT_HEADERS,
    data: { titleId: movie.id },
  });
  expect(start.status(), await start.text()).toBe(201);
  const session = (await start.json()) as { id: string };
  await request.delete(`/api/v1/playback/sessions/${session.id}`, {
    headers: { "X-Webflix-Client": "web" },
  });
});

test("an ended membership restarts through a new checkout, without a second trial", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  await createBareAccount(request, "billing-restart");
  await subscribe(request, { planId: "standard", card: freshCard() });
  await addProfile(request);
  const cancel = await request.delete("/api/v1/account/subscription", { headers: CLIENT_HEADERS });
  expect(cancel.status(), await cancel.text()).toBe(200);
  await advancePast(request, (await membershipOf(request)).trialEndsAt ?? "", RENEWAL_SETTLE_SEC);
  expect((await membershipOf(request)).status).toBe("canceled");
  const movie = await aMovie(request);

  await page.goto(`/watch/${movie.id}`);
  await expect(page.getByRole("heading", { name: "Your membership has ended" })).toBeVisible();
  await page.getByRole("link", { name: "Restart membership" }).click();
  await expect(page.getByRole("heading", { name: "Restart your membership" })).toBeVisible();
  await page.getByRole("button", { name: "Continue with Standard" }).click();
  await expect(page.getByRole("region", { name: "Your plan" })).toContainText("$12.99");
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await page.getByLabel(/type a test card number/i).fill(freshCard("mastercard"));
  await page.getByRole("button", { name: "Save card" }).click();
  // The account had its trial: the payment is asked for, and a returning member is never told
  // it is a "first payment" (UX review 2.2).
  await expect(page.getByRole("heading", { name: "Restart Standard" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/first payment|first month/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Pay $12.99" }).click();
  await expect(page).toHaveURL(/\/_pay\/form\?/);
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible({
    timeout: 20_000,
  });
  expect((await membershipOf(request)).status).toBe("active");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page).toHaveURL(/\/browse/);
});

test("billing history lists the provider's invoices", async ({ page }) => {
  const request = page.context().request;
  const card = await spentCard(request);
  await createBareAccount(request, "billing-invoices");
  await subscribe(request, { planId: "standard", card });
  await addProfile(request);
  await page.goto("/account/membership/invoices");
  await expect(page.getByRole("heading", { name: "Billing history" })).toBeVisible();
  const rows = page.getByRole("main").getByRole("listitem");
  await expect(rows.first()).toContainText("$12.99");
  await expect(rows.first()).toContainText("Paid");
  await expectAccessible(page);
});

test("membership changes work with the keyboard alone: change plan, cancel, keep", async ({
  page,
}) => {
  const request = page.context().request;
  const card = await spentCard(request);
  await createBareAccount(request, "billing-keyboard");
  await subscribe(request, { planId: "standard", card });
  await addProfile(request);

  await page.goto("/account/membership");
  await expect(page.getByRole("heading", { name: "Membership", level: 1 })).toBeVisible();
  await tabTo(page, page.getByRole("link", { name: "Change plan" }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("radio", { name: /Standard/ }));
  // Held as a person holds a key: the group moves and selects while it is down.
  await page.keyboard.down("ArrowRight");
  await expect(page.getByRole("radio", { name: /Premium/ })).toBeChecked();
  await page.keyboard.up("ArrowRight");
  const pay = page.getByRole("button", { name: /^Pay \$\d+\.\d\d and switch$/ });
  await tabTo(page, pay);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/account\/membership$/);
  await expect.poll(async () => (await membershipOf(request)).planId).toBe("premium");

  await tabTo(page, page.getByRole("link", { name: "Cancel membership" }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("button", { name: "Finish cancellation" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Your membership ends on/).first()).toBeVisible();
  await tabTo(page, page.getByRole("button", { name: "Keep my membership" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Your membership ends on/)).toHaveCount(0);
  expect((await membershipOf(request)).cancelAtPeriodEnd).toBe(false);
});

test("on a phone the account strip brings the current section into view and shows that it scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const request = page.context().request;
  await createBareAccount(request, "billing-strip");
  await subscribe(request, { planId: "basic", card: freshCard() });
  await addProfile(request);
  const strip = page.getByRole("navigation", { name: "Account" });
  await page.goto("/account/privacy");
  await expect(strip.getByRole("link", { name: "Privacy" })).toBeInViewport();
  // Sections lie beyond both edges: the strip fades there.
  await expect
    .poll(() => strip.locator("ul").evaluate((list) => getComputedStyle(list).maskImage))
    .toContain("linear-gradient");
  await page.goto("/account/membership");
  await expect(strip.getByRole("link", { name: "Membership" })).toBeInViewport();
});

test("a scheduled deletion: the membership says so, offers nothing billing would refuse, and leads to Privacy", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  await createBareAccount(request, "billing-deletion");
  await subscribe(request, { planId: "standard", card: freshCard() });
  await addProfile(request);
  const deletionDue = Date.parse(await scheduleDeletion(request));
  const trialEnds = Date.parse((await membershipOf(request)).trialEndsAt ?? "");
  test.skip(
    !(trialEnds < deletionDue),
    "the deletion is due before the free trial ends here (a short WEBFLIX_DELETION_COOLING_OFF_SEC); this spec needs the trial to end first, as with the default 14 days",
  );

  await page.goto("/account/membership");
  const notice = page.getByText(/Your account is scheduled to be deleted on/);
  await expect(notice).toBeVisible();
  // The same truth as Privacy (UX review 2.1): watching carries on until the trial ends (it
  // comes before the deletion), and nothing more is charged; no "first payment" is promised.
  await expect(
    page.getByText(
      /You can keep watching until .+, when your free trial ends, and nothing more is charged\./,
    ),
  ).toBeVisible();
  await expect(page.getByText("First payment")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Change plan" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Keep my membership" })).toHaveCount(0);
  await expectAccessible(page);
  await page.goto("/account/membership/plan");
  await expect(notice).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);

  // The trial runs out while the deletion waits: the paywall leads to Privacy, not to a restart.
  await advancePast(request, (await membershipOf(request)).trialEndsAt ?? "", RENEWAL_SETTLE_SEC);
  expect((await membershipOf(request)).status).toBe("canceled");
  const movie = await aMovie(request);
  await page.goto(`/watch/${movie.id}`);
  await expect(
    page.getByRole("heading", { name: /Your account is scheduled to be deleted on/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Restart membership" })).toHaveCount(0);
  await page.getByRole("link", { name: "Go to Account › Privacy" }).click();
  await expect(page).toHaveURL(/\/account\/privacy/);

  // Keeping the account gives the choices back.
  await page.getByRole("button", { name: "Keep my account" }).first().click();
  await expect
    .poll(async () => {
      const list = (await (await request.get("/api/v1/privacy/requests")).json()) as {
        items: Array<{ kind: string; status: string }>;
      };
      return list.items.some((item) => item.kind === "deletion" && item.status === "scheduled");
    })
    .toBe(false);
  await page.goto("/account/membership");
  await expect(page.getByText(/scheduled to be deleted/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Restart membership" }).first()).toBeVisible();
});
