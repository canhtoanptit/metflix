import { expect, test } from "./fixtures.ts";
import {
  answerIssuer,
  giveProfile,
  passwordAccount,
  requireDevIssuer,
} from "./identity-support.ts";
import { expectAccessible, PASSWORD, uniqueEmail } from "./member-support.ts";

/**
 * Account › Security (docs/BLUEPRINT-M2.md §4.1, §4.2): linked sign-in methods, "Confirm it's
 * you" with the password or with a fresh sign-in at a provider, a first password for an account
 * created with Google, and unlinking that says what it means.
 */

test("Link Google after confirming with the password; unlink it, and it never relinks by itself", async ({
  page,
  newDevice,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("link");
  await passwordAccount(page.context().request, email, PASSWORD);
  await giveProfile(page.context().request, "Sam");

  await page.goto("/account/security");
  const methods = page.getByRole("region", { name: "Ways to sign in" });
  await expect(methods.getByText("Not linked").first()).toBeVisible();
  await expectAccessible(page);

  // Linking needs a fresh proof: the password, asked for in "Confirm it's you".
  await methods.getByRole("button", { name: "Link Google" }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toContainText("To link Google, confirm you're the account holder.");
  await expect(prompt.getByLabel("Webflix password")).toBeFocused();
  await expectAccessible(page);
  await prompt.getByLabel("Webflix password").fill("not-the-password");
  await prompt.getByRole("button", { name: "Confirm" }).click();
  await expect(prompt.getByLabel("Webflix password")).toHaveAccessibleDescription(/isn't right/);
  await expect(prompt.getByLabel("Webflix password")).toHaveValue("");
  await prompt.getByLabel("Webflix password").fill(PASSWORD);
  await prompt.getByRole("button", { name: "Confirm" }).click();

  // Then the provider, then back here.
  await answerIssuer(page, { email });
  const linked = page.getByRole("status").filter({ hasText: "Google is linked" });
  await expect(linked).toBeFocused();
  await expect(page).toHaveURL(/\/account\/security$/);
  const google = methods.getByRole("listitem").filter({ hasText: "Google" });
  await expect(google).toContainText(`Linked · ${email}`);

  // Unlinking says what it means before it happens.
  await google.getByRole("button", { name: "Unlink Google" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Unlink Google?" });
  await expect(confirm).toContainText("won't reconnect on its own");
  await expect(confirm).toContainText("Devices that are signed in now stay signed in");
  await confirm.getByRole("button", { name: "Unlink Google" }).click();
  await expect(page.getByText("Google is unlinked", { exact: true }).first()).toBeVisible();
  await expect(google).toContainText("Not linked");

  // The removed identity signs in to nothing: an account uses its address, so it must sign in.
  const elsewhere = await newDevice();
  const other = await elsewhere.newPage();
  await other.goto("/login");
  await other.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(other, { email });
  await expect(other.getByText("An account already uses this address")).toBeVisible();
});

test("A Google-only member sets a first password, confirming with a fresh Google sign-in", async ({
  page,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("google-only");
  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  await expect(page.getByRole("heading", { name: "Welcome to Webflix" })).toBeVisible();
  await giveProfile(page.context().request);

  await page.goto("/account/security");
  const methods = page.getByRole("region", { name: "Ways to sign in" });
  await expect(methods).toContainText("No password yet");
  // Its only way in cannot be unlinked, and the page says why.
  await expect(methods.getByText("Your only way to sign in")).toBeVisible();
  await expect(methods.getByRole("button", { name: "Unlink Google" })).toHaveCount(0);

  // Confirm it's you comes first: the new password is typed only once that is done, so the
  // round trip to Google never throws away what the member typed.
  const section = page.getByRole("region", { name: "Password", exact: true });
  await section.getByRole("button", { name: "Set a password" }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toContainText("To set a password");
  await expect(section.getByLabel("New password")).toHaveCount(0);
  // No password to offer: a fresh sign-in with Google is the proof.
  await expect(prompt.getByLabel("Webflix password")).toHaveCount(0);
  await expectAccessible(page);
  await prompt.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });

  // Back here, confirmed: the field is offered now, with focus, and typed once.
  await expect(page.getByText("Confirmed it's you", { exact: true }).first()).toBeVisible();
  const form = page.getByRole("form", { name: "Set a password" });
  await expect(form.getByLabel("New password")).toBeFocused();
  await form.getByLabel("New password").fill("a first long passphrase");
  await form.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password set", { exact: true }).first()).toBeVisible();
  await expect(methods).toContainText(`Signs in as ${email}`);
  await expect(section.getByRole("button", { name: "Change password" })).toBeFocused();

  const login = await page.context().request.post("/api/v1/auth/login", {
    headers: { "X-Webflix-Client": "web", "content-type": "application/json" },
    data: { email, password: "a first long passphrase" },
  });
  expect(login.ok()).toBe(true);
});

test("Confirm it's you when the provider says no: told so, with the other ways still offered", async ({
  page,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("reauth-fail");
  await passwordAccount(page.context().request, email, PASSWORD);
  await giveProfile(page.context().request, "Sam");
  // Link Google first (with the password), so it is offered as a proof.
  await page.goto("/account/security");
  await page.getByRole("button", { name: "Link Google" }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await prompt.getByLabel("Webflix password").fill(PASSWORD);
  await prompt.getByRole("button", { name: "Confirm" }).click();
  await answerIssuer(page, { email });
  await expect(page.getByText("Google is linked")).toBeVisible();

  // A new session holds no proof (the one just given belongs to the old session).
  await page.context().clearCookies();
  const relogin = await page.context().request.post("/api/v1/auth/login", {
    headers: { "X-Webflix-Client": "web", "content-type": "application/json" },
    data: { email, password: PASSWORD },
  });
  expect(relogin.ok()).toBe(true);
  const session = (await relogin.json()) as { profiles: Array<{ id: string }> };
  await page.context().request.put("/api/v1/session/profile", {
    headers: { "X-Webflix-Client": "web", "content-type": "application/json" },
    data: { profileId: session.profiles[0]?.id },
  });

  await page.goto("/account/security");
  await page.getByRole("button", { name: "Unlink Google" }).click();
  await page
    .getByRole("alertdialog", { name: "Unlink Google?" })
    .getByRole("button", { name: "Unlink Google" })
    .click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("link", { name: "Use Google instead" }).click();
  // Another Google account than the linked one: the provider cannot confirm it's this member.
  await answerIssuer(page, { email: uniqueEmail("someone-else") });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole("alert")).toContainText("Google couldn't confirm it's you");
  await expect(prompt.getByLabel("Webflix password")).toBeVisible();
  await prompt.getByLabel("Webflix password").fill(PASSWORD);
  await prompt.getByRole("button", { name: "Confirm" }).click();
  // Confirmed in the reopened prompt: the action it was for is offered again.
  const confirm = page.getByRole("alertdialog", { name: "Unlink Google?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Unlink Google" }).click();
  await expect(page.getByText("Google is unlinked", { exact: true }).first()).toBeVisible();
});

test("A Google-only member locks a profile and removes a forgotten PIN, confirming with Google", async ({
  page,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("google-pin");
  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  await expect(page.getByRole("heading", { name: "Welcome to Webflix" })).toBeVisible();
  const profileId = await giveProfile(page.context().request, "Sam");

  // Locking a profile loosens nothing a password could prove here: Google proves it instead.
  await page.goto(`/profiles/${profileId}/edit`);
  await page.getByRole("button", { name: "Add a PIN" }).click();
  const lock = page.getByRole("dialog", { name: "Lock this profile" });
  await lock.getByLabel("Digit 1 of 4").pressSequentially("2580");
  await lock.getByRole("button", { name: "Save PIN" }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toContainText("To lock Sam, confirm you're the account holder.");
  await expect(prompt.getByLabel("Webflix password")).toHaveCount(0);
  await expectAccessible(page);
  await prompt.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });

  // Back on the editor, the lock dialog again: the PIN typed before the round trip is gone.
  const again = page.getByRole("dialog", { name: "Lock this profile" });
  await expect(again.getByText("You're confirmed")).toBeVisible();
  await again.getByLabel("Digit 1 of 4").pressSequentially("2580");
  await again.getByRole("button", { name: "Save PIN" }).click();
  await expect(page.getByText("Locked with a PIN")).toBeVisible();

  // A new session (no proof yet) at Who's watching?: the PIN is forgotten.
  await page.context().clearCookies({ name: "webflix_session" });
  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  // The provider's own session signs straight back in (single sign-on), to the profile gate.
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
  await page.getByRole("button", { name: /^Sam/ }).click();
  const pin = page.getByRole("dialog", { name: "Profile lock is on" });
  await pin.getByRole("button", { name: "Forgot PIN?" }).click();
  const forgot = page.getByRole("dialog", { name: "Remove profile lock" });
  await forgot.getByRole("button", { name: "Remove lock" }).click();
  await expect(prompt).toContainText("To remove the lock from Sam");
  await prompt.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  // Back at the gate, the removal is offered again for the same profile; now it goes through.
  await page
    .getByRole("dialog", { name: "Remove profile lock" })
    .getByRole("button", { name: "Remove lock" })
    .click();
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toHaveCount(0);
  // The gate closes while the removal is still on its way: read until it has landed.
  await expect
    .poll(async () => {
      const profiles = (await (await page.context().request.get("/api/v1/profiles")).json()) as {
        items: Array<{ id: string; isLocked: boolean }>;
      };
      return profiles.items.find((item) => item.id === profileId)?.isLocked;
    })
    .toBe(false);
});

test("Linking refused for want of a fresh proof: said so, and the confirmation is asked for again", async ({
  page,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("link-refused");
  await passwordAccount(page.context().request, email, PASSWORD);
  await giveProfile(page.context().request, "Sam");
  // Straight to the start route without a proof, as a stale tab would: the server refuses the
  // navigation and sends the browser back with the reason.
  await page.goto(
    `/api/v1/auth/oidc/google/start?intent=link&returnTo=${encodeURIComponent("/account/security?provider=google")}`,
  );
  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByText("Confirm it's you again to link Google")).toBeVisible();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toContainText("To link Google");
  await prompt.getByLabel("Webflix password").fill(PASSWORD);
  await prompt.getByRole("button", { name: "Confirm" }).click();
  const next = page.getByRole("alertdialog", { name: "Link Google" });
  await next.getByRole("button", { name: "Continue to Google" }).click();
  await answerIssuer(page, { email });
  await expect(page.getByText("Google is linked")).toBeVisible();
});
