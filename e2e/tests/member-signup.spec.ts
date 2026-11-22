import { expect, test } from "./fixtures.ts";
import { DEMO, expectAccessible, PASSWORD, uniqueEmail } from "./member-support.ts";

/**
 * The first impression: landing → sign-up (the account first, then plan and payment in the
 * provider's form) → profiles → home, against the real API. The payment journeys themselves
 * (declines, challenges, promo codes, coming back half-way) are billing-signup.spec.ts.
 */

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

test("sign-up end to end: validation, the account first, payment at the provider, profiles", async ({
  page,
}) => {
  const email = uniqueEmail("signup");
  let signups = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/auth/signup")) signups += 1;
  });

  // Step 1: inline validation that helps, then the account is created (without a membership).
  await page.goto(`/signup?email=${encodeURIComponent(email)}`);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeFocused();
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAccessibleDescription(
    /at least 8 characters/,
  );
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Create account" }).dblclick();

  // Step 2: the highlighted plan is preselected; the choice is kept in the URL.
  await expect(page).toHaveURL(/\/signup\/plan/);
  expect(signups, "a double click creates one account").toBe(1);
  await expect(page.getByRole("radio", { name: /Standard/ })).toBeChecked();
  await page.getByRole("radio", { name: /Basic/ }).click();
  await expect(page).toHaveURL(/plan=basic/);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: no card field on Webflix's page; the card goes to the provider's own form.
  await expect(page).toHaveURL(/\/signup\/payment\?plan=basic/);
  await expect(page.getByRole("region", { name: "Your plan" })).toContainText("Basic");
  await expect(page.getByRole("textbox", { name: /card number/i })).toHaveCount(0);
  // Back and forward keep the plan; a refresh keeps the step.
  await page.goBack();
  await expect(page).toHaveURL(/\/signup\/plan\?plan=basic/);
  await page.goForward();
  await page.reload();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page).toHaveURL(/\/_pay\/form\?/);
  await page.getByLabel(/type a test card number/i).fill(`visa:signup-${Date.now()}`);
  await page.getByRole("button", { name: "Save card", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your free trial has started" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Create your profiles" }).click();

  // Step 4: name the people who watch.
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeFocused();
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Profile 2 name (optional)").fill("Pip");
  // Each row has its own Kids control, always visible.
  const kids = page.getByRole("checkbox", { name: "Profile 2 is a kids profile" });
  await expect(page.getByRole("checkbox", { name: /is a kids profile$/ })).toHaveCount(4);
  await kids.check();
  // Pictures are chosen here, not assigned: pick the last one offered for Pip.
  await page.getByRole("button", { name: "Choose a picture for Pip" }).click();
  const picker = page.getByRole("dialog", { name: "Choose a profile picture" });
  const choice = picker.getByRole("radio").last();
  const chosenName = (await choice.getAttribute("aria-label")) ?? "";
  await choice.click();
  await expectAccessible(page);
  await picker.getByRole("button", { name: "Use this picture" }).click();
  await expect(picker).toBeHidden();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Create 2 profiles" }).click();
  await expect(page).toHaveURL(/\/browse/);

  // The account really exists with both profiles, the second one a kids profile with the
  // picture chosen for it; the brand-new account was never asked for its password.
  const session = await (await page.context().request.get("/api/v1/session")).json();
  expect(session.membership.planId).toBe("basic");
  expect(session.membership.status).toBe("trialing");
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
  const pip = session.profiles.find((profile: { name: string }) => profile.name === "Pip");
  expect(pip.avatar.name).toBe(chosenName);

  // Back from the app never reopens the finished sign-up steps.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/signup\/(plan|payment|profile)/);
});

test("a known email is caught on step 1, with a way to sign in", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Email address").fill(DEMO.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
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
