import { expect, test } from "./fixtures.ts";
import { answerIssuer, requireDevIssuer } from "./identity-support.ts";
import { CLIENT_HEADERS, expectAccessible, PASSWORD, uniqueEmail } from "./member-support.ts";

/**
 * Sign in and sign up with Google and Apple through the development issuer (docs/BLUEPRINT-M2.md
 * §4.1), every outcome the issuer can produce, as a member meets it: a new account, an existing
 * one, an account that must sign in first, a cancel, a failure, a tab closed half-way, and the
 * callback landing in another tab than the one that started it.
 */

test("Continue with Google creates an account: a welcome that says so, then the sign-up funnel", async ({
  page,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("google-new");
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });

  const welcome = page.getByRole("heading", { name: "Welcome to Webflix" });
  await expect(welcome).toBeFocused();
  await expect(page).toHaveURL(/\/login\/continue\?.*oidc=signed-up/);
  await expect(page.getByText("so we created one")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expectAccessible(page);

  const session = await (await page.context().request.get("/api/v1/session")).json();
  expect(session.authenticated).toBe(true);
  expect(session.account.hasPassword).toBe(false);
  await page.getByRole("link", { name: "Choose your plan" }).click();
  await expect(page).toHaveURL(/\/signup/);
});

test("Continue with Apple (a cross-site form post) signs an existing member back in", async ({
  page,
  newDevice,
  request,
}) => {
  await requireDevIssuer(request, "apple");
  const email = uniqueEmail("apple");
  // The account, created through Apple in another browser.
  const first = await newDevice();
  const firstPage = await first.newPage();
  await firstPage.goto("/login");
  await firstPage.getByRole("link", { name: "Continue with Apple" }).click();
  await answerIssuer(firstPage, { email });
  await expect(firstPage.getByRole("heading", { name: "Welcome to Webflix" })).toBeVisible();

  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Apple" }).click();
  await answerIssuer(page, { email });
  // Signed in, never welcomed again; an account without a membership resumes the funnel.
  await expect(page.getByText("Signed in with Apple", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/signup/);
  await expect(page.getByRole("heading", { name: "Welcome to Webflix" })).toHaveCount(0);
});

test("Cancel at the provider: back on sign-in, told calmly, nothing created", async ({
  page,
  request,
}) => {
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("google-cancel");
  await page.goto("/login?redirect=%2Faccount");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email, cancel: true });

  const notice = page.getByRole("status").filter({ hasText: "Google sign-in cancelled" });
  await expect(notice).toBeFocused();
  await expect(notice).toContainText("Nothing changed");
  // The message does not come back on a reload; the destination is kept.
  await expect(page).toHaveURL(/\/login\?redirect=%2Faccount$/);
  await expectAccessible(page);
  const status = await (
    await request.get(`/api/v1/auth/email-status?email=${encodeURIComponent(email)}`)
  ).json();
  expect(status.next).toBe("signup");
  await page.reload();
  await expect(page.getByText("Google sign-in cancelled")).toHaveCount(0);
});

test("A refused answer from the provider: an honest failure and a way to try again", async ({
  page,
  request,
}) => {
  await requireDevIssuer(request, "google");
  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  const email = uniqueEmail("google-fault");
  await answerIssuer(page, { email, faults: ["wrongAudience"] });

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("We couldn't sign in with Google");
  await expect(alert).toContainText("Nothing was changed");
  await expect(alert).toBeFocused();
  // The provider still holds its own session from the first attempt, so the retry comes
  // straight back signed up, as Google's single sign-on would.
  await alert.getByRole("link", { name: "Try again with Google" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to Webflix" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
});

test("Refused for too many attempts: the sign-in page says to wait, not that something broke", async ({
  page,
}) => {
  // Where the server sends a browser whose start it refused under the rate limit (its returnTo,
  // the sign-in landing, with the reason).
  await page.goto(
    "/login/continue?provider=google&context=signin&from=%2Flogin&oidc=failed&oidcError=rate_limited",
  );
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Too many attempts");
  await expect(alert).toContainText("Try again in a minute");
  await expect(alert.getByRole("link", { name: "Try again with Google" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/login$/);
});

test("An account already uses the address: sign in first, told no more than the server said", async ({
  page,
  newDevice,
  request,
}) => {
  await requireDevIssuer(request, "google");
  // A password account whose address is not verified: the provider may not attach itself.
  const email = uniqueEmail("link-required");
  const owner = await newDevice();
  const signup = await owner.request.post("/api/v1/auth/signup", {
    headers: CLIENT_HEADERS,
    data: { email, password: PASSWORD },
  });
  expect(signup.status()).toBe(201);

  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  const panel = page.getByRole("status").filter({ hasText: "You already have a Webflix account" });
  await expect(panel).toBeFocused();
  await expect(panel).toContainText("link Google in Account › Security");
  await expect(panel).not.toContainText(email);
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
  await expectAccessible(page);
  const session = await (await page.context().request.get("/api/v1/session")).json();
  expect(session.authenticated).toBe(false);

  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // No profile yet: the funnel resumes.
  await expect(page).toHaveURL(/\/signup/);
});

test("The provider's answer lands in another tab: that tab continues, and so does this one", async ({
  page,
  request,
}) => {
  await requireDevIssuer(request, "google");
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // Opened in a new tab (a modifier click): this tab stays on sign-in.
  const [other] = await Promise.all([
    page.context().waitForEvent("page"),
    page
      .getByRole("link", { name: "Continue with Google" })
      .click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] }),
  ]);
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await answerIssuer(other, { email: uniqueEmail("other-tab") });
  await expect(other.getByRole("heading", { name: "Welcome to Webflix" })).toBeVisible();
  // The first tab hears it and leaves sign-in by itself.
  await page.bringToFront();
  await expect(page).toHaveURL(/\/signup/);
});

test("Half-way and back: Back from the provider, a closed tab, an old landing link", async ({
  page,
  request,
}) => {
  await requireDevIssuer(request, "google");
  await page.goto("/login");
  const google = page.getByRole("link", { name: "Continue with Google" });
  await google.click();
  await expect(page.locator('form[data-dev-idp="sign-in"]')).toBeVisible();
  // Back from the provider's page: the button works again (not stuck on "Opening Google…").
  await page.goBack();
  await expect(google).toBeVisible();
  await expect(google).toHaveText("Continue with Google");

  // The tab closed on the provider's page: a new tab starts over cleanly.
  const [closing] = await Promise.all([
    page.context().waitForEvent("page"),
    google.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] }),
  ]);
  await expect(closing.locator('form[data-dev-idp="sign-in"]')).toBeVisible();
  await closing.close();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await google.click();
  await answerIssuer(page, { email: uniqueEmail("restart") });
  await expect(page.getByRole("heading", { name: "Welcome to Webflix" })).toBeVisible();

  // An old "signed in" landing URL opened in a signed-out browser says so honestly.
  await page.context().clearCookies();
  await page.goto("/login/continue?provider=google&context=signin&oidc=signed-in");
  await expect(page.getByRole("heading", { name: "You're not signed in" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Try again with Google" })).toBeVisible();
});
