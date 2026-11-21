import { catalogCards, escapeRegExp } from "./api.ts";
import { expect, test } from "./fixtures.ts";
import {
  CARDS,
  CLIENT_HEADERS,
  createAccount,
  expectAccessible,
  fillCard,
  PASSWORD,
  uniqueEmail,
} from "./member-support.ts";

/** Account management against the real API, each test on its own fresh account. */

test("change plan: the effects are explained; a declined card changes nothing", async ({
  page,
}) => {
  await createAccount(page.context().request, { plan: "basic", tag: "plan" });
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Change plan" }).click();
  await expect(page).toHaveURL(/\/account\/plan/);
  await page.getByRole("radio", { name: /Premium/ }).click();
  const summary = page.getByRole("status").filter({ hasText: "Switching to Premium" });
  await expect(summary).toContainText(/You'll pay about \$\d+\.\d\d today/);
  await expect(summary).toContainText("4 screens at a time");
  await expectAccessible(page);

  // A new card that is declined: the plan stays Basic.
  await page.getByRole("checkbox", { name: "Use a different card" }).check();
  await fillCard(page, CARDS.declined);
  await page.getByRole("button", { name: "Switch to Premium" }).click();
  await expect(page.getByRole("alert")).toContainText("Your plan hasn't changed");
  let session = await (await page.context().request.get("/api/v1/session")).json();
  expect(session.plan.id).toBe("basic");

  // The card on file works.
  await page.getByRole("checkbox", { name: "Use a different card" }).uncheck();
  await page.getByRole("button", { name: "Switch to Premium" }).click();
  await expect(page).toHaveURL(/\/account$/);
  session = await (await page.context().request.get("/api/v1/session")).json();
  expect(session.plan.id).toBe("premium");

  // A downgrade warns that extra streams stop.
  await page.goto("/account/plan");
  await page.getByRole("radio", { name: /Basic/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Switching to Basic" })).toContainText(
    "the most recent streams will stop",
  );
});

test("cancel with a clear end date, then keep the membership", async ({ page }) => {
  await createAccount(page.context().request, { tag: "cancel" });
  await page.goto("/account");
  await page.getByRole("link", { name: "Cancel membership" }).click();
  await expect(page.getByRole("heading", { name: "Cancel your membership?" })).toBeVisible();
  await expect(page.getByText(/You can keep watching until/)).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Finish cancellation" }).click();
  await expect(page).toHaveURL(/\/account$/);
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

test("update the payment method", async ({ page }) => {
  await createAccount(page.context().request, { tag: "card" });
  await page.goto("/account");
  await page.getByRole("button", { name: "Update payment method" }).click();
  const dialog = page.getByRole("dialog", { name: "Update payment method" });
  await fillCard(page, "5555555555554444");
  await dialog.getByRole("button", { name: "Save card" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Mastercard •••• 4444")).toBeVisible();
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
