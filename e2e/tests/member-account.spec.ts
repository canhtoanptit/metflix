import { catalogCards, escapeRegExp } from "./api.ts";
import { expect, test } from "./fixtures.ts";
import {
  CLIENT_HEADERS,
  createAccount,
  expectAccessible,
  PASSWORD,
  uniqueEmail,
} from "./member-support.ts";

/** Account management against the real API, each test on its own fresh account. */

test("change plan: the provider's preview is shown as charged, no card is asked for", async ({
  page,
}) => {
  // A paying member (createAccount: a provider checkout, past the trial).
  await createAccount(page.context().request, { plan: "basic", tag: "plan" });
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Manage membership" }).click();
  await page.getByRole("link", { name: "Change plan" }).click();
  await expect(page).toHaveURL(/\/account\/membership\/plan/);
  await page.getByRole("radio", { name: /Premium/ }).click();
  const summary = page.getByRole("status").filter({ hasText: "Switching to Premium" });
  // The provider's own preview: what is charged today, and what the change brings.
  await expect(summary).toContainText(/Charged today\s*\$\d+\.\d\d/);
  await expect(summary).toContainText("4 screens at a time");
  // Milestone 2: card details are never typed into Webflix's page.
  await expect(page.getByRole("textbox", { name: /card number/i })).toHaveCount(0);
  await expectAccessible(page);

  // The card on file at the provider is charged.
  await page.getByRole("button", { name: /^Pay \$\d+\.\d\d and switch$/ }).click();
  await expect(page).toHaveURL(/\/account\/membership$/);
  await expect
    .poll(async () => (await (await page.context().request.get("/api/v1/session")).json()).plan?.id)
    .toBe("premium");

  // A downgrade warns that extra streams stop.
  await page.goto("/account/plan");
  await page.getByRole("radio", { name: /Basic/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Switching to Basic" })).toContainText(
    "the most recent streams will stop",
  );
});

test("cancel with a clear end date, then keep the membership", async ({ page }) => {
  await createAccount(page.context().request, { tag: "cancel" });
  await page.goto("/account/membership");
  await page.getByRole("link", { name: "Cancel membership" }).click();
  await expect(page.getByRole("heading", { name: "Cancel your membership?" })).toBeVisible();
  await expect(page.getByText(/You can keep watching until/)).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Finish cancellation" }).click();
  await expect(page).toHaveURL(/\/account\/membership$/);
  await expect(page.getByText(/Your membership ends on/).first()).toBeVisible();
  let session = await (await page.context().request.get("/api/v1/session")).json();
  expect(session.subscription.status).toBe("canceling");

  // The gate reminds, too.
  await page.goto("/profiles");
  await expect(page.getByText(/Your membership ends on/)).toBeVisible();
  await page.getByRole("link", { name: "Keep my membership" }).click();
  await page.getByRole("button", { name: "Keep my membership" }).click();
  await expect(page.getByText(/Your membership ends on/)).toHaveCount(0);
  session = await (await page.context().request.get("/api/v1/session")).json();
  expect(session.subscription.status).toBe("active");
});

test("change email and password with the current password", async ({ page, newDevice }) => {
  const account = await createAccount(page.context().request, { tag: "security" });
  // Another signed-in device, which a password change signs out.
  const other = await newDevice();
  await other.request.post("/api/v1/auth/login", {
    headers: CLIENT_HEADERS,
    data: { email: account.email, password: PASSWORD },
  });

  await page.goto("/account/security");
  await expectAccessible(page);
  const email = page.getByRole("form", { name: "Change email" });
  const next = uniqueEmail("renamed");
  await email.getByLabel("New email address").fill(next);
  await email.getByLabel("Current password").fill("wrong-password-1");
  await email.getByRole("button", { name: "Update email" }).click();
  await expect(email.getByLabel("Current password")).toHaveAccessibleDescription(/isn't right/);
  await email.getByLabel("Current password").fill(PASSWORD);
  await email.getByRole("button", { name: "Update email" }).click();
  await expect(page.getByText(`You sign in with ${next}.`)).toBeVisible();

  const password = page.getByRole("form", { name: "Change password" });
  await password.getByLabel("Current password").fill(PASSWORD);
  await password.getByLabel("New password").fill("short");
  await password.getByRole("button", { name: "Change password" }).click();
  await expect(password.getByLabel("New password")).toHaveAccessibleDescription(/at least 8/);
  await password.getByLabel("New password").fill("a brand new passphrase");
  await password.getByRole("button", { name: "Change password" }).click();
  await expect(password.getByLabel("Current password")).toHaveValue("");

  const otherSession = await (await other.request.get("/api/v1/session")).json();
  expect(otherSession.authenticated).toBe(false);
  const relogin = await page.context().request.post("/api/v1/auth/login", {
    headers: CLIENT_HEADERS,
    data: { email: next, password: "a brand new passphrase" },
  });
  expect(relogin.ok()).toBe(true);
});

test("viewing activity lists what was watched and removes entries", async ({ page }) => {
  await createAccount(page.context().request, { tag: "activity" });
  // Watch a little of a movie through the API: a session, one heartbeat, then stop.
  const request = page.context().request;
  const movie = (await catalogCards(request)).find((card) => card.type === "movie");
  if (!movie) throw new Error("no movie in the catalogue");
  const session = await (
    await request.post("/api/v1/playback/sessions", {
      headers: CLIENT_HEADERS,
      data: { titleId: movie.id, startPositionSec: 0 },
    })
  ).json();
  const heartbeat = await request.post(`/api/v1/playback/sessions/${session.id}/heartbeat`, {
    headers: CLIENT_HEADERS,
    data: {
      positionSec: Math.min(60, Math.floor(session.durationSec / 2)),
      durationSec: session.durationSec,
      state: "playing",
    },
  });
  expect(heartbeat.status(), await heartbeat.text()).toBe(200);
  // No body, so no JSON content type: an empty body declared as JSON is malformed.
  const stop = await request.delete(`/api/v1/playback/sessions/${session.id}`, {
    headers: { "X-Webflix-Client": "web" },
  });
  expect(stop.status(), await stop.text()).toBe(204);

  await page.goto("/account/activity");
  const remove = page.getByRole("button", {
    name: new RegExp(`^Remove ${escapeRegExp(movie.name)}`),
  });
  await expect(remove).toBeVisible();
  await expectAccessible(page);
  // The row leaves at once (optimistic); the server has it once the DELETE has answered.
  const removed = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" && /\/api\/v1\/history\//.test(response.url()),
  );
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(page.getByText("Nothing watched yet")).toBeVisible();
  expect((await removed).status()).toBe(204);
  const history = await (await request.get("/api/v1/history")).json();
  expect(history.items).toEqual([]);
});
