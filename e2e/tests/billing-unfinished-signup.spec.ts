import type { Page } from "@playwright/test";
import { uniqueEmail } from "./api.ts";
import {
  createBareAccount,
  freshCard,
  PASSWORD,
  requireFakeProvider,
  subscribe,
} from "./billing-support.ts";
import { expect, test } from "./fixtures.ts";
import { answerIssuer, requireDevIssuer } from "./identity-support.ts";
import { expectAccessible } from "./member-support.ts";

/**
 * An account that stopped part-way through sign-up (UX review 1.1) is still its holder's: Account,
 * Security, Devices, Privacy and Membership open without a profile, finishing sign-up is offered
 * there (never forced), and the sign-up flow has a way to the account. The server treats a
 * session with no profile as the account holder while the account has no profiles.
 */

test.beforeEach(async ({ page }) => {
  await requireFakeProvider(page.context().request);
});

const SECTIONS = [
  { link: "Membership", heading: "Membership", path: /\/account\/membership$/ },
  { link: "Security", heading: "Security", path: /\/account\/security$/ },
  { link: "Devices", heading: "Devices", path: /\/account\/devices$/ },
  { link: "Privacy", heading: "Privacy", path: /\/account\/privacy$/ },
] as const;

/** Every account section opens, in place, with the notice that offers finishing sign-up. */
async function expectAccountOpen(page: Page, notice: string): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Account" });
  // Profiles and their viewing activity come with finishing sign-up.
  await expect(nav.getByRole("link", { name: "Profiles" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Viewing activity" })).toHaveCount(0);
  for (const section of SECTIONS) {
    await nav.getByRole("link", { name: section.link }).click();
    await expect(page).toHaveURL(section.path);
    await expect(page.getByRole("heading", { level: 1, name: section.heading })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: notice })).toBeVisible();
  }
  await expect(page.getByText(/Something went wrong|We couldn't load/)).toHaveCount(0);
}

test("an account that stopped at the plan opens its account pages from sign-up, and goes back to finish", async ({
  page,
}) => {
  const email = uniqueEmail("billing-unfinished");
  await page.goto("/signup");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: /Choose the plan/ })).toBeVisible();

  // The sign-up header leads to the account.
  await page
    .getByRole("navigation", { name: "Your account" })
    .getByRole("link", { name: "Account" })
    .click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  await expect(page.getByText(email).first()).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Finish setting up Webflix" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Privacy" })).toBeVisible();
  await expectAccessible(page);

  await expectAccountOpen(page, "Finish setting up Webflix");
  await page
    .getByRole("navigation", { name: "Account" })
    .getByRole("link", { name: "Membership" })
    .click();
  await expect(page.getByText("No plan yet")).toBeVisible();
  await expectAccessible(page);

  // Finishing is one step away, and lands where sign-up stopped.
  await page.getByRole("link", { name: "Finish setting up" }).click();
  await expect(page).toHaveURL(/\/signup\/plan/);
  await expect(page.getByRole("heading", { name: /Choose the plan/ })).toBeVisible();
});

test("an account that paid but has no profile yet sees its membership, and is offered its profiles", async ({
  page,
}) => {
  const request = page.context().request;
  await createBareAccount(request, "billing-unfinished-paid");
  await subscribe(request, { planId: "standard", card: freshCard("visa") });

  await page.goto("/account/membership");
  await expect(page.getByRole("heading", { level: 1, name: "Membership" })).toBeVisible();
  await expect(page.getByTestId("membership-status")).toHaveText("Free trial");
  await expect(
    page.getByRole("status").filter({ hasText: "Create your profiles to start watching" }),
  ).toBeVisible();
  await expectAccountOpen(page, "Create your profiles to start watching");

  await page.getByRole("link", { name: "Create profiles" }).click();
  await expect(page).toHaveURL(/\/signup\/profile/);
  await page.getByLabel("Your name").fill("Riley");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page).toHaveURL(/\/browse/);

  // Once a profile exists, the account is managed from a profile again.
  await page.goto("/account");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Create your profiles" })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Profiles" }),
  ).toBeVisible();
});

test("a Google-only account with no profile confirms with Google to set a password", async ({
  page,
}) => {
  const name = await requireDevIssuer(page.context().request, "google");
  const email = uniqueEmail("billing-unfinished-google");
  await page.goto("/signup");
  await page.getByRole("link", { name: `Continue with ${name}` }).click();
  await answerIssuer(page, { email });
  await page.getByRole("link", { name: "Choose your plan" }).click();
  await expect(page).toHaveURL(/\/signup\/plan/);

  await page.getByRole("link", { name: "Account" }).click();
  await expect(page.getByText("Not set: you sign in with Google or Apple")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Account" })
    .getByRole("link", { name: "Security" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();

  // Confirm it's you first (a full navigation to the provider), then the password, typed once.
  const section = page.getByRole("region", { name: "Password", exact: true });
  await section.getByRole("button", { name: "Set a password" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("link", { name: `Continue with ${name}` }).click();
  await answerIssuer(page, { email });
  await expect(page).toHaveURL(/\/account\/security/);
  await expect(page.getByText(/Confirmed it's you/).first()).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password set").first()).toBeVisible();
  await expect(section.getByRole("button", { name: "Change password" })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Finish setting up Webflix" }),
  ).toBeVisible();

  // And it can ask for its deletion (just confirmed with Google, so no second proof).
  await page
    .getByRole("navigation", { name: "Account" })
    .getByRole("link", { name: "Privacy" })
    .click();
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete my account" }).click();
  await expect(page.getByText(/Your account will be deleted on/).first()).toBeVisible({
    timeout: 20_000,
  });
});
