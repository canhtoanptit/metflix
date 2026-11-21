import { expect, test } from "./fixtures.ts";
import {
  CARDS,
  DEMO,
  expectAccessible,
  fillCard,
  PASSWORD,
  uniqueEmail,
} from "./member-support.ts";

/** The first impression: landing → sign-up → membership → profiles → home, against the real API. */

test("landing routes a known email to sign in and a new one to sign up", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectAccessible(page);

  const capture = page.getByRole("form", { name: /start your membership or sign back in/ }).first();
  await capture.getByLabel("Email address").fill(DEMO.email);
  await capture.getByRole("button", { name: "Get started" }).click();
  await expect(page).toHaveURL(/\/login\?email=demo%40webflix\.dev/);
  // The URL changes as navigation starts; the landing (and its own email fields) stays on
  // screen until the sign-in screen's code has loaded. Look inside the sign-in form.
  const signIn = page.getByRole("form", { name: "Sign in" });
  await expect(signIn.getByLabel("Email address")).toHaveValue(DEMO.email);

  await page.goto("/");
  const email = uniqueEmail("landing");
  await page.getByLabel("Email address").first().fill(email);
  await page.getByRole("button", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/signup\?email=/);
  const signUp = page.getByRole("form", { name: "Create your account" });
  await expect(signUp.getByLabel("Email address")).toHaveValue(email);
});

test("the landing email capture helps with a typo instead of navigating", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").first().fill("sam@example");
  await page.getByRole("button", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("Email address").first()).toHaveAttribute("aria-invalid", "true");
});

test("sign-up end to end: validation, declined cards, a refresh mid-flow, profiles", async ({
  page,
}) => {
  const email = uniqueEmail("signup");
  let signups = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/auth/signup")) signups += 1;
  });

  // Step 1: inline validation that helps, then on.
  await page.goto(`/signup?email=${encodeURIComponent(email)}`);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeFocused();
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAccessibleDescription(
    /at least 8 characters/,
  );
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: the highlighted plan is preselected; the choice is kept in the URL.
  await expect(page).toHaveURL(/\/signup\/plan/);
  await expect(page.getByRole("radio", { name: /Standard/ })).toBeChecked();
  await page.getByRole("radio", { name: /Basic/ }).click();
  await expect(page).toHaveURL(/plan=basic/);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: empty submit focuses the first problem; a declined card keeps the form.
  await expect(page).toHaveURL(/\/signup\/payment\?plan=basic/);
  await expect(page.getByText("Basic · ")).toBeVisible();
  await page.getByRole("button", { name: "Start membership" }).click();
  await expect(page.getByLabel("Card number")).toBeFocused();
  await fillCard(page, CARDS.declined);
  await expect(page.getByLabel("Card number")).toHaveValue("4000 0000 0000 0002");
  await page.getByRole("button", { name: "Start membership" }).click();
  await expect(page.getByRole("alert")).toContainText("Your card was declined");
  await expect(page.getByLabel("Card number")).toBeFocused();
  await expect(page.getByLabel("Name on card")).toHaveValue("E2E Tester");
  await expectAccessible(page);

  // Back and forward keep the draft; a refresh asks for the password again (never stored).
  await page.goBack();
  await expect(page).toHaveURL(/\/signup\/plan\?plan=basic/);
  await page.goForward();
  await expect(page).toHaveURL(/\/signup\/payment/);
  await page.reload();
  await expect(
    page.getByText(`Enter the password you chose for ${email}`, { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await fillCard(page, CARDS.insufficientFunds);
  await page.getByRole("button", { name: "Start membership" }).click();
  await expect(page.getByRole("alert")).toContainText("insufficient funds");

  // Approved; a double click sends one request.
  await page.getByLabel("Card number").fill(CARDS.approved);
  const before = signups;
  await page.getByRole("button", { name: "Start membership" }).dblclick();
  await expect(page).toHaveURL(/\/signup\/profile/);
  expect(signups - before).toBe(1);

  // Step 4: name the people who watch.
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeFocused();
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Profile 2 name (optional)").fill("Pip");
  await page.getByRole("checkbox", { name: "Kids profile" }).first().check();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Create 2 profiles" }).click();
  await expect(page).toHaveURL(/\/browse/);

  // The account really exists with both profiles, the second one a kids profile.
  const session = await (await page.context().request.get("/api/v1/session")).json();
  expect(session.plan.id).toBe("basic");
  expect(session.activeProfile.name).toBe("Sam");
  expect(
    session.profiles.map((profile: { name: string; isKids: boolean }) => [
      profile.name,
      profile.isKids,
    ]),
  ).toEqual([
    ["Sam", false],
    ["Pip", true],
  ]);

  // Back from the app never reopens the finished sign-up steps.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/signup/);
});

test("a known email is caught on step 1, with a way to sign in", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Email address").fill(DEMO.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Email address")).toHaveAccessibleDescription(
    /already a Webflix account/,
  );
  await page.getByRole("link", { name: "Sign in instead" }).click();
  await expect(page).toHaveURL(/\/login\?email=demo%40webflix\.dev/);
});

test("deep links into later steps send the visitor back to what is missing", async ({ page }) => {
  await page.goto("/signup/payment?plan=premium");
  await expect(page).toHaveURL(/\/signup$/);
  await page.goto("/signup/profile");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fsignup%2Fprofile/);
});
