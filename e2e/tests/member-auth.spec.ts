import { expect, test } from "./fixtures.ts";
import { CLIENT_HEADERS, createAccount, expectAccessible, PASSWORD } from "./member-support.ts";

/** Sign in and sign out against the real API. */

test("sign in: every error is said clearly, then it continues where the member was going", async ({
  page,
  newDevice,
}) => {
  // A fresh account so the attempt counts and session list are this test's own.
  const setup = await newDevice();
  const account = await createAccount(setup.request, { tag: "signin" });
  await setup.close();

  await page.goto("/account/activity");
  await expect(page).toHaveURL(/\/login\?redirect=%2Faccount%2Factivity/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expectAccessible(page);

  // Nothing typed: errors are tied to the fields and focus goes to the first one.
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Email address")).toBeFocused();
  await expect(page.getByLabel("Email address")).toHaveAccessibleDescription(/Enter your email/);

  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Incorrect email or password");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await expectAccessible(page);

  // Remember me off: a browser-session cookie.
  await page.getByRole("checkbox", { name: "Remember me" }).uncheck();
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Signed in without an active profile: the gate first, keeping the destination.
  await expect(page).toHaveURL(/\/profiles\?redirect=%2Faccount%2Factivity/);
  const cookie = (await page.context().cookies()).find((item) =>
    item.name.includes("webflix_session"),
  );
  expect(cookie?.expires).toBe(-1);
  await page.getByRole("button", { name: /^Sam/ }).click();
  await expect(page).toHaveURL(/\/account\/activity$/);
});

test("rate limiting shows a visible timer and keeps the button disabled", async ({ page }) => {
  test.skip(
    !process.env.E2E_STRICT_RATE_LIMITS,
    "needs an API with strict auth limits, e.g. WEBFLIX_RATE_LIMIT_AUTH=3/60",
  );
  await page.goto("/login?email=demo%40webflix.dev");
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const button = page.getByRole("button", { name: /^Sign in$|^Try again in/ });
    if (await button.isDisabled()) break;
    await page.getByLabel("Password", { exact: true }).fill(`wrong-${attempt}-password`);
    await button.click();
    await expect(page.getByRole("alert")).toBeVisible();
  }
  await expect(page.getByRole("alert")).toContainText("Too many sign-in attempts");
  await expect(page.getByRole("button", { name: /Try again in \d:\d\d/ })).toBeDisabled();
});

test("sign out: a calm confirmation, and the app is closed behind it", async ({ page }) => {
  await createAccount(page.context().request, { tag: "signout" });
  await page.goto("/account");
  await page.goto("/logout");
  await expect(page.getByTestId("signed-out")).toBeVisible();
  await expect(page.getByRole("heading", { name: "You've signed out" })).toBeFocused();
  await expectAccessible(page);
  await page.goto("/browse");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fbrowse/);
});

test("sign out of all devices from Account signs this browser out too", async ({ newDevice }) => {
  const first = await newDevice();
  const account = await createAccount(first.request, { tag: "everywhere" });
  const second = await newDevice();
  const login = await second.request.post("/api/v1/auth/login", {
    headers: CLIENT_HEADERS,
    data: { email: account.email, password: PASSWORD },
  });
  expect(login.ok()).toBe(true);

  const page = await first.newPage();
  await page.goto("/account/devices");
  await expect(
    page.getByRole("region", { name: "Signed-in devices" }).getByRole("listitem"),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Sign out of all devices" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Sign out of all devices?" });
  await expectAccessible(page);
  await confirm.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page).toHaveURL(/\/login/);
  const other = await (await second.request.get("/api/v1/session")).json();
  expect(other.authenticated).toBe(false);
});
