import { expect, test } from "./fixtures.ts";
import { emailedLink, passwordAccount } from "./identity-support.ts";
import { CLIENT_HEADERS, expectAccessible, PASSWORD, uniqueEmail } from "./member-support.ts";

/**
 * The emailed links (docs/BLUEPRINT-M2.md §4.3): the token is in the URL fragment, which never
 * reaches a server; a link works once; a used, expired or altered one gets one honest screen.
 * Resetting a password signs every device out, and the page says so before it happens.
 */

test("Forgot password: the same answer for any address, a single-use link, every device signed out", async ({
  page,
  newDevice,
}) => {
  const email = uniqueEmail("reset");
  const owner = await newDevice();
  await passwordAccount(owner.request, email, PASSWORD);

  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toHaveValue(email);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Email me a link" }).click();
  const sent = page.getByRole("heading", { name: "Check your email" });
  await expect(sent).toBeFocused();
  await expect(page.getByText(`If a Webflix account uses ${email}`)).toBeVisible();
  await expect(page.getByRole("button", { name: /Send again in/ })).toBeDisabled();

  // An address with no account gets exactly the same screen.
  await page.getByRole("button", { name: "Use a different email" }).click();
  const nobody = uniqueEmail("nobody");
  await page.getByLabel("Email address").fill(nobody);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByText(`If a Webflix account uses ${nobody}`)).toBeVisible();

  const link = await emailedLink(page.context().request, email, "reset-password");
  expect(link).toMatch(/^\/reset-password#token=/);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  // The token leaves the address bar once read.
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(
    page.getByText("Every device signed in to your account is signed out"),
  ).toBeVisible();
  await expect(page.getByText("linked under a different email address is unlinked")).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("New password", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByLabel("New password", { exact: true })).toHaveAccessibleDescription(
    /at least 8/,
  );
  await page.getByLabel("New password", { exact: true }).fill("a brand new passphrase");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeFocused();

  const ownerSession = await (await owner.request.get("/api/v1/session")).json();
  expect(ownerSession.authenticated).toBe(false);
  const login = await page.context().request.post("/api/v1/auth/login", {
    headers: CLIENT_HEADERS,
    data: { email, password: "a brand new passphrase" },
  });
  expect(login.ok()).toBe(true);

  // The same link again: one honest screen, and the way to a new one.
  await page.context().clearCookies();
  await page.goto(link);
  await page.getByLabel("New password", { exact: true }).fill("another long passphrase");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Send a new link" })).toBeVisible();
  await expectAccessible(page);
});

test("An altered reset link is refused at once, without asking for a password", async ({
  page,
}) => {
  await page.goto("/reset-password#token=cut-short");
  await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveCount(0);
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
});

test("Verify email: the link verifies on opening; again, it says the address is verified", async ({
  page,
}) => {
  const email = uniqueEmail("verify");
  await passwordAccount(page.context().request, email, PASSWORD);
  const link = await emailedLink(page.context().request, email, "verify-email");
  expect(link).toMatch(/^\/verify-email#token=/);

  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Your email is verified" })).toBeFocused();
  await expect(page).toHaveURL(/\/verify-email$/);
  await expectAccessible(page);
  const session = await (await page.context().request.get("/api/v1/session")).json();
  expect(session.account.emailVerified).toBe(true);

  // Used already, by this signed-in account whose address is verified: no false alarm.
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Your email is already verified" })).toBeVisible();

  // Signed out, the used link is a dead link, with the way to a new one.
  await page.context().clearCookies();
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in to get a new link" })).toBeVisible();
});
