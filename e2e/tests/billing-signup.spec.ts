import type { Page } from "@playwright/test";
import { CLIENT_HEADERS, uniqueEmail } from "./api.ts";
import {
  addProfile,
  confirmAtProvider,
  createBareAccount,
  expectCardDataOnlyAtProvider,
  freshCard,
  membershipOf,
  PASSWORD,
  requireFakeProvider,
  scheduleDeletion,
  spentCard,
  tabTo,
  watchCardData,
} from "./billing-support.ts";
import { expect, test } from "./fixtures.ts";
import { answerIssuer, requireDevIssuer } from "./identity-support.ts";
import { expectAccessible } from "./member-support.ts";

/**
 * Sign-up in milestone 2's order (docs/BLUEPRINT-M2.md §5.1) against the real API and the fake
 * payment provider's own form: the account first, then the plan, the card typed only into the
 * provider's page, the confirming state, then profiles. Each test is a new account.
 */

test.beforeEach(async ({ page }) => {
  await requireFakeProvider(page.context().request);
});

/** Step 1 through the page: create the account with an email and a password. */
async function createAccount(page: Page, tag: string): Promise<string> {
  const email = uniqueEmail(tag);
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeFocused();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: /Choose the plan/ })).toBeVisible();
  return email;
}

/** On the provider's form (`/_pay/form`): type a test card's number or name and save it. */
async function payAtProvider(page: Page, card: string, button: "Save card" | "Pay" = "Save card") {
  await expect(page).toHaveURL(/\/_pay\/form\?/);
  await page.getByLabel(/type a test card number/i).fill(card);
  await page.getByRole("button", { name: button, exact: true }).click();
}

test("sign-up end to end: account, plan, the provider's form, a trial, profiles, home", async ({
  page,
}) => {
  const cardData = watchCardData(page);
  await createAccount(page, "billing-signup");

  // Step 2, signed in: the account exists without a membership.
  expect((await membershipOf(page.context().request)).status).toBe("none");
  await page.getByRole("radio", { name: /Premium/ }).click();
  await expect(page).toHaveURL(/plan=premium/);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: what is due today and after, and no card field on Webflix's page.
  await expect(page.getByRole("heading", { name: "Set up your payment" })).toBeVisible();
  const plan = page.getByRole("region", { name: "Your plan" });
  await expect(plan).toContainText("Premium");
  await expect(plan).toContainText("Due today");
  await expect(plan).toContainText("$0.00");
  // A new account is told its trial for certain (the server decided it: UX review 2.6).
  await expect(plan).toContainText("Your 7-day free trial starts today (one per card)");
  await expect(page.getByText(/if you haven't had a Webflix trial/)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /card number/i })).toHaveCount(0);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue to payment" }).click();

  // The provider's own form; the card goes there and nowhere else.
  await payAtProvider(page, freshCard("visa"));

  // Confirming, then the welcome: the membership is the provider's, confirmed by the server.
  await expect(page).toHaveURL(/\/signup\/confirm\?checkout=/);
  await expect(page.getByRole("heading", { name: "Your free trial has started" })).toBeFocused({
    timeout: 20_000,
  });
  await expectAccessible(page);
  const membership = await membershipOf(page.context().request);
  expect(membership.status).toBe("trialing");
  expect(membership.planId).toBe("premium");

  // A reload of the welcome shows it again (the checkout is in the URL).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your free trial has started" })).toBeVisible();

  await page.getByRole("button", { name: "Create your profiles" }).click();
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeFocused();
  await page.getByLabel("Your name").fill("Sam");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page).toHaveURL(/\/browse/);
  // Back from the app never reopens the finished sign-up.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/signup\/(plan|payment)/);

  expectCardDataOnlyAtProvider(cardData());
  expect(cardData().length, "the card was typed into the provider's form").toBeGreaterThan(0);
});

test("sign up with Google: the new account, without a password or membership, goes on to choose a plan and pay", async ({
  page,
}) => {
  const name = await requireDevIssuer(page.context().request, "google");
  await page.goto("/signup");
  await page.getByRole("link", { name: `Continue with ${name}` }).click();
  await answerIssuer(page, { email: uniqueEmail("billing-google") });
  await expect(page.getByRole("heading", { name: "Welcome to Webflix" })).toBeVisible();
  await page.getByRole("link", { name: "Choose your plan" }).click();
  await expect(page).toHaveURL(/\/signup\/plan/);
  await expect(page.getByRole("heading", { name: /Choose the plan/ })).toBeVisible();
  expect((await membershipOf(page.context().request)).status).toBe("none");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await payAtProvider(page, freshCard("visa"));
  await expect(page.getByRole("heading", { name: "Your free trial has started" })).toBeVisible({
    timeout: 20_000,
  });
  // Profiles come last, and nothing asks this account for a password it never had.
  await page.getByRole("button", { name: "Create your profiles" }).click();
  await page.getByLabel("Your name").fill("Riley");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page).toHaveURL(/\/browse/);
});

test("the whole sign-up works with the keyboard alone", async ({ page }) => {
  const email = uniqueEmail("billing-keyboard");
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeFocused();
  await tabTo(page, page.getByLabel("Email address"));
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: /Choose the plan/ })).toBeFocused();
  await tabTo(page, page.getByRole("radio", { name: /Standard/ }));
  // A key held as a person holds it: the radio group moves (and selects) while it is down.
  await page.keyboard.down("ArrowLeft");
  await expect(page.getByRole("radio", { name: /Basic/ })).toBeChecked();
  await page.keyboard.up("ArrowLeft");
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Set up your payment" })).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Continue to payment" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/_pay\/form\?/);
  const number = page.getByLabel(/type a test card number/i);
  await tabTo(page, number);
  await page.keyboard.type(freshCard("visa"));
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Your free trial has started" })).toBeFocused({
    timeout: 20_000,
  });
  await tabTo(page, page.getByRole("button", { name: "Create your profiles" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeFocused();
  await tabTo(page, page.getByLabel("Your name"));
  await page.keyboard.type("Sam");
  await tabTo(page, page.getByRole("button", { name: "Start watching" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/browse/);
});

test("a declined card at the provider: the form brings the member back, told why, and another card works", async ({
  page,
}) => {
  const cardData = watchCardData(page);
  await createAccount(page, "billing-declined");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await payAtProvider(page, "4000000000009995");

  // The provider's form returns by itself (`payment=failed`); Webflix asks the server why.
  await expect(page).toHaveURL(/\/signup\/confirm\?checkout=.*payment=failed/);
  await expect(
    page.getByRole("heading", { name: "Your card was declined for insufficient funds" }),
  ).toBeFocused({ timeout: 20_000 });
  await expect(page.getByText(/Nothing was charged/)).toBeVisible();
  await expectAccessible(page);
  expect((await membershipOf(page.context().request)).status).toBe("none");

  await page.getByRole("link", { name: "Use another card" }).click();
  // The payment step still says what happened (UX review 2.13), focused for screen readers.
  const notice = page.getByRole("alert").filter({ hasText: "Your card was declined" });
  await expect(notice).toBeFocused();
  await expect(notice).toContainText("Nothing was charged.");
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await payAtProvider(page, freshCard("mastercard"));
  await expect(page.getByRole("heading", { name: "Your free trial has started" })).toBeVisible({
    timeout: 20_000,
  });
  expectCardDataOnlyAtProvider(cardData());
});

test("returning from the provider without a card: Webflix says no card was added, not that it was declined", async ({
  page,
}) => {
  await createAccount(page, "billing-cancel");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page).toHaveURL(/\/_pay\/form\?/);
  await page.getByRole("link", { name: "Cancel and return" }).click();
  await expect(page.getByRole("heading", { name: "No card was added" })).toBeFocused({
    timeout: 20_000,
  });
  await expect(page.getByText(/declined/i)).toHaveCount(0);
  await page.getByRole("link", { name: "Add a card" }).click();
  await expect(page.getByRole("button", { name: "Continue to payment" })).toBeVisible();
});

test("a card that needs a challenge: confirmed only once the challenge is completed", async ({
  page,
}) => {
  await createAccount(page, "billing-challenge");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await payAtProvider(page, freshCard("challenge"));
  await expect(page).toHaveURL(/\/_pay\/challenge/);
  expect((await membershipOf(page.context().request)).status).toBe("none");
  await page.getByRole("button", { name: "Complete authentication" }).click();
  await expect(page.getByRole("heading", { name: "Your free trial has started" })).toBeVisible({
    timeout: 20_000,
  });
});

test("no trial on a card that had one: the first payment is shown, confirmed at the provider, and survives a reload", async ({
  page,
}) => {
  const card = await spentCard(page.context().request);
  await page.context().clearCookies();
  await createAccount(page, "billing-first-payment");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await payAtProvider(page, card);

  // No trial: the amount due today, before anything is charged.
  const heading = page.getByRole("heading", { name: "Confirm your first payment" });
  await expect(heading).toBeFocused({ timeout: 20_000 });
  await expect(page.getByText("$12.99").first()).toBeVisible();
  expect((await membershipOf(page.context().request)).status).toBe("incomplete");
  await expectAccessible(page);

  // A reload (or a closed tab) comes back to the same step.
  await page.reload();
  await expect(heading).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Pay $12.99" }).click();
  await payAtProvider(page, card, "Pay");
  await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("You paid $12.99 today.")).toBeVisible();
  expect((await membershipOf(page.context().request)).status).toBe("active");
});

test("promo codes: an unknown one is refused with its reason; a valid one is quoted and charged as quoted", async ({
  page,
}) => {
  const card = await spentCard(page.context().request);
  await page.context().clearCookies();
  await createAccount(page, "billing-promo");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Have a promo code?" }).click();
  const code = page.getByRole("textbox", { name: "Promo code" });
  await expect(code).toBeFocused();
  await code.fill("NOSUCHCODE");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(code).toHaveAccessibleDescription(/don't recognise this code/);
  await expect(code).toBeFocused();
  await code.fill("WEBFLIX50");
  await page.getByRole("button", { name: "Apply" }).click();
  // A new account gets a trial (the card's own history is the only exception): one true
  // sentence, in the info tone, not a green "applied" beside $0.00 (UX review 2.5).
  await expect(page.getByText(/WEBFLIX50 stays yours/)).toContainText(
    "the code applies only if this card has had a trial before",
  );
  await expectAccessible(page);

  await page.getByRole("button", { name: "Continue to payment" }).click();
  await payAtProvider(page, card);
  await expect(page.getByRole("heading", { name: "Confirm your first payment" })).toBeVisible({
    timeout: 20_000,
  });
  // This card had its trial: the code takes its share off the first payment, said with why.
  await expect(page.getByText("$12.99 less your $6.50 WEBFLIX50 discount")).toBeVisible();
  await page.getByRole("button", { name: "Pay $6.49" }).click();
  await payAtProvider(page, card, "Pay");
  await expect(
    page.getByText("You paid $6.49 today ($12.99 less your $6.50 WEBFLIX50 discount)."),
  ).toBeVisible({ timeout: 20_000 });
  // The provider charged exactly the quoted price (the account's invoices need a profile).
  const request = page.context().request;
  await addProfile(request);
  const invoices = (await (await request.get("/api/v1/billing/invoices")).json()) as {
    items: Array<{ amountPaid: { amountMinor: number } }>;
  };
  expect(invoices.items.map((invoice) => invoice.amountPaid.amountMinor)).toContain(649);
});

test("coming back half-way: sign in resumes at the plan, and at the payment awaiting confirmation", async ({
  page,
  newDevice,
}) => {
  // An account that stopped after step 1.
  const request = page.context().request;
  const bare = await createBareAccount(request, "billing-resume");
  await page.context().clearCookies();
  await page.goto(`/login?email=${encodeURIComponent(bare.email)}`);
  await page.getByLabel("Password", { exact: true }).fill(bare.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/signup\/plan/);
  await expect(page.getByRole("heading", { name: /Choose the plan/ })).toBeVisible();

  // The same account, its first payment started on another device and not yet paid (with a
  // card whose trial a third device's throwaway account spent).
  const spender = await newDevice();
  const card = await spentCard(spender.request);
  const other = await newDevice();
  const login = await other.request.post("/api/v1/auth/login", {
    headers: CLIENT_HEADERS,
    data: { email: bare.email, password: bare.password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const start = await other.request.post("/api/v1/billing/checkout", {
    headers: CLIENT_HEADERS,
    data: { planId: "basic" },
  });
  expect(start.status(), await start.text()).toBe(201);
  const started = (await start.json()) as { id: string; clientSecret: string };
  await confirmAtProvider(other.request, started.clientSecret, card);
  const confirmed = await other.request.post(`/api/v1/billing/checkout/${started.id}/confirm`, {
    headers: CLIENT_HEADERS,
  });
  expect(confirmed.status(), await confirmed.text()).toBe(200);
  expect((await membershipOf(other.request)).status).toBe("incomplete");

  // Back on the first device: the funnel's entry sends it to the payment awaiting confirmation.
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Confirm your first payment" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("$7.99").first()).toBeVisible();
});

test("a promo code is never spent on a trial: the welcome says it wasn't used and is still theirs", async ({
  page,
}) => {
  await createAccount(page, "billing-promo-trial");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Have a promo code?" }).click();
  await page.getByRole("textbox", { name: "Promo code" }).fill("WEBFLIX50");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/WEBFLIX50 stays yours/)).toBeVisible();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await payAtProvider(page, freshCard("visa"));
  await expect(page.getByRole("heading", { name: "Your free trial has started" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByText(
      "Your code WEBFLIX50 wasn't used, because the free trial costs nothing: it's still yours.",
    ),
  ).toBeVisible();
  // The first payment after the trial is the full price, said exactly.
  await expect(page.getByText(/Your first payment, \$12\.99, is due that day/)).toBeVisible();
});

test("a checkout started on one device, with its promo code, continues on another", async ({
  page,
  newDevice,
}) => {
  const email = await createAccount(page, "billing-cross-device");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Have a promo code?" }).click();
  await page.getByRole("textbox", { name: "Promo code" }).fill("WEBFLIX50");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/WEBFLIX50 stays yours/)).toBeVisible();

  // Another device signs in to the same account: the funnel's entry finds the open checkout.
  const other = await newDevice();
  const tablet = await other.newPage();
  await tablet.goto(`/login?email=${encodeURIComponent(email)}`);
  await tablet.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await tablet.getByRole("button", { name: "Sign in" }).click();
  await expect(tablet).toHaveURL(/\/signup\/payment\?plan=standard/);
  await expect(tablet.getByText(/WEBFLIX50 stays yours/)).toBeVisible();
});

test("an account whose deletion is scheduled is told so at the payment step, not offered a checkout", async ({
  page,
}) => {
  const request = page.context().request;
  await createBareAccount(request, "billing-deletion-signup");
  await addProfile(request);
  await scheduleDeletion(request);
  await page.goto("/signup/payment?plan=standard");
  await expect(page.getByText(/Your account is scheduled to be deleted on/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to payment" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Go to Privacy" })).toBeVisible();
});
