import { expect, test } from "./fixtures.ts";
import {
  answerIssuer,
  answerIssuerIfAsked,
  emailedLink,
  giveProfile,
  passwordAccount,
  requireDevIssuer,
} from "./identity-support.ts";
import { expectAccessible, PASSWORD, uniqueEmail } from "./member-support.ts";

/**
 * `link-required` (docs/BLUEPRINT-M2.md §4.1, security review H1): a provider attaches itself only
 * to an account whose ways in its owner set up, so a member whose Google address already has a
 * Webflix account is asked to prove that account first. Either way through, they end up with
 * "Google is linked" in one deliberate path: sign in with the password and accept one offer, or
 * reset the password, be signed in by the reset, and accept the same offer.
 */

test("Knows the password: sign in, choose a profile, and adding Google is one click", async ({
  page,
  newDevice,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("lr-password");
  const owner = await newDevice();
  await passwordAccount(owner.request, email, PASSWORD);
  await giveProfile(owner.request, "Sam");

  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  const panel = page
    .getByRole("status")
    .filter({ hasText: "An account already uses this address" });
  await expect(panel).toBeFocused();
  await expect(panel).toContainText("Google can't be added to it automatically");
  await expect(panel).toContainText("you'll be offered to add Google right after");
  await expect(panel).toContainText("Reset the password. The account becomes yours");
  // Nothing beyond what the outcome itself tells: no address.
  await expect(panel).not.toContainText(email);
  await expect(panel.getByRole("link", { name: "Reset the password" })).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // Who's watching? says where choosing leads.
  await expect(
    page.getByText("Choose your profile, then add Google to your account."),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Sam/ }).click();

  const offer = page.getByRole("alertdialog", { name: "Add Google to your account?" });
  await expect(offer).toContainText("You tried to sign in with Google");
  await expectAccessible(page);
  await offer.getByRole("button", { name: "Add Google" }).click();
  // The password typed to sign in was the proof: "Confirm it's you" is not asked again.
  const linked = page.getByText("Google is linked");
  await answerIssuerIfAsked(page, { email }, linked);
  await expect(linked).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(
    page.getByRole("region", { name: "Ways to sign in" }).getByRole("listitem").filter({
      hasText: "Google",
    }),
  ).toContainText("Linked");
});

test("Doesn't know the password: reset it, signed in by the reset, then add Google", async ({
  page,
  newDevice,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("lr-reset");
  // Whoever set the account up is still signed in elsewhere; the reset signs them out.
  const owner = await newDevice();
  await passwordAccount(owner.request, email, PASSWORD);
  await giveProfile(owner.request, "Sam");

  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  await page.getByRole("link", { name: "Reset the password" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByText("you'll be signed in and offered to add Google")).toBeVisible();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  // The emailed link opens in a new tab.
  const link = await emailedLink(page.context().request, email, "reset-password");
  const tab = await page.context().newPage();
  await tab.goto(link);
  await expect(tab.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(tab.getByText("Then you'll be offered to add Google to the account.")).toBeVisible();
  await expect(
    tab.getByText("Every other device signed in to your account is signed out"),
  ).toBeVisible();
  await tab.getByLabel("New password", { exact: true }).fill("a brand new passphrase");
  await tab.getByRole("button", { name: "Save new password" }).click();
  await expect(
    tab.getByText("You're signed in here, and signed out everywhere else.").first(),
  ).toBeVisible();
  await tab.getByRole("button", { name: /^Sam/ }).click();
  const offer = tab.getByRole("alertdialog", { name: "Add Google to your account?" });
  await offer.getByRole("button", { name: "Add Google" }).click();
  const linked = tab.getByText("Google is linked");
  await answerIssuerIfAsked(tab, { email }, linked);
  await expect(linked).toBeVisible();
  await expect(tab.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);

  const ownerSession = await (await owner.request.get("/api/v1/session")).json();
  expect(ownerSession.authenticated).toBe(false);
});

test("Not now: the offer can be declined, and Account still offers the link", async ({
  page,
  newDevice,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("lr-later");
  const owner = await newDevice();
  await passwordAccount(owner.request, email, PASSWORD);

  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // No profile yet: Security opens directly (the account is its own account holder).
  const offer = page.getByRole("alertdialog", { name: "Add Google to your account?" });
  await offer.getByRole("button", { name: "Not now" }).click();
  await expect(offer).toBeHidden();
  await expect(page.getByRole("button", { name: "Link Google" })).toBeVisible();
  // Offered once: a reload does not ask again.
  await page.reload();
  await expect(page.getByRole("button", { name: "Link Google" })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
