/**
 * The staff console's session and access rules, through the real development staff issuer:
 * signing in and out, a reload, what each role sees in the navigation and behind a pasted link,
 * a staff member without a role, the API being down, and where tokens are (memory only).
 */
import AxeBuilder from "@axe-core/playwright";
import { addLockedProfile, adminPath, createMember, signInToConsole } from "./admin-helpers.ts";
import { expect, test } from "./fixtures.ts";

const STAFF_API = "/api/admin/v1/";

test("signs in at the staff issuer, survives a reload, and signs out for good", async ({
  page,
}) => {
  await signInToConsole(page, "staff-admin", "operations/health");
  await expect(page.getByRole("heading", { level: 1, name: "System health" })).toBeVisible();
  await expect(page.getByText("Morgan Blake").first()).toBeAttached();

  // A reload loses the in-memory tokens; the issuer's session signs straight back in, same page.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "System health" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/operations\/health$/);

  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "You're signed out" })).toBeVisible();
  // Signed out on purpose: loading the console again does not sign back in.
  await page.goto(adminPath("operations/health"));
  await expect(
    page.getByRole("heading", { level: 1, name: /Sign in to the staff console|You're signed out/ }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "System health" })).toHaveCount(0);
});

test("keeps tokens in memory: nothing in storage or cookies, no cookie on staff calls", async ({
  page,
}) => {
  const staffCalls: { cookie: string | undefined; authorization: string | undefined }[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith(STAFF_API)) {
      const headers = request.headers();
      staffCalls.push({ cookie: headers.cookie, authorization: headers.authorization });
    }
  });
  await signInToConsole(page, "staff-support", "members");
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  const stored = await page.evaluate(() => {
    const dump = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index) ?? "";
        return `${key}=${storage.getItem(key) ?? ""}`;
      });
    return { local: dump(localStorage), session: dump(sessionStorage), cookie: document.cookie };
  });
  // The one sign-in transaction was removed by the callback; nothing token-shaped is anywhere.
  expect(stored.local).toEqual([]);
  expect(stored.session).toEqual([]);
  expect(stored.cookie).toBe("");
  expect(staffCalls.length).toBeGreaterThan(0);
  for (const call of staffCalls) {
    expect(call.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(call.cookie ?? "").toBe("");
  }
  // The code and state left the address bar and the history entry.
  expect(page.url()).not.toMatch(/code=|state=/);
});

test("a support agent sees Members only, and a pasted link to the audit log calls nothing", async ({
  page,
}) => {
  await signInToConsole(page, "staff-support");
  const nav = page.getByRole("navigation", { name: "Console" }).first();
  await expect(nav.getByRole("link", { name: "Members" })).toBeVisible();
  for (const hidden of [
    "Plans & prices",
    "Experiments",
    "Billboards",
    "Audit log",
    "System health",
  ]) {
    await expect(nav.getByRole("link", { name: hidden })).toHaveCount(0);
  }
  const auditCalls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(`${STAFF_API}audit`) || path.startsWith(`${STAFF_API}system`)) {
      auditCalls.push(path);
    }
  });
  await page.goto(adminPath("operations/audit"));
  await expect(
    page.getByRole("heading", { name: "You don't have access to the audit log" }),
  ).toBeVisible();
  await expect(page.getByText("needs the Admin role")).toBeVisible();
  await page.goto(adminPath("plans"));
  await expect(
    page.getByRole("heading", { name: "You don't have access to Plans & prices" }),
  ).toBeVisible();
  expect(auditCalls).toEqual([]);
});

test("each role's navigation opens exactly its areas", async ({ page }) => {
  const cases = [
    {
      persona: "staff-content",
      shows: ["Billboards", "Collections", "Availability"],
      hides: ["Members", "Experiments", "Audit log"],
    },
    {
      persona: "staff-experiments",
      shows: ["Experiments"],
      hides: ["Members", "Billboards", "Plans & prices"],
    },
    {
      persona: "staff-billing",
      shows: ["Plans & prices"],
      hides: ["Members", "Billboards", "Audit log"],
    },
  ] as const;
  for (const { persona, shows, hides } of cases) {
    await page.context().clearCookies();
    await signInToConsole(page, persona);
    const nav = page.getByRole("navigation", { name: "Console" }).first();
    for (const name of shows) await expect(nav.getByRole("link", { name })).toBeVisible();
    for (const name of hides) await expect(nav.getByRole("link", { name })).toHaveCount(0);
  }
});

test("a staff account without a Webflix role is told so, with a way out", async ({ page }) => {
  await signInToConsole(page, "staff-no-role");
  await expect(
    page.getByRole("heading", { level: 1, name: "Your account has no staff role" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Console" })).toHaveCount(0);
});

test("says the staff API is down instead of showing an empty console", async ({ page }) => {
  await page.route(`**${STAFF_API}me`, (route) => route.abort("connectionrefused"));
  await signInToConsole(page, "staff-no-role");
  await expect(
    page.getByRole("heading", { level: 1, name: "Can't reach the staff API" }),
  ).toBeVisible();
  await page.unroute(`**${STAFF_API}me`);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your account has no staff role" }),
  ).toBeVisible();
});

test("console screens pass automated accessibility checks", async ({ page }) => {
  const member = await createMember("a11y");
  await addLockedProfile(member, "Kitchen");
  await signInToConsole(page, "staff-admin");
  for (const path of [
    "",
    "members",
    `members/${member.accountId}`,
    "plans",
    "content/billboards",
    "content/collections/new",
    "experiments/new",
    "operations/health",
    "operations/audit",
  ]) {
    await page.goto(adminPath(path));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map((violation) => `${path}: ${violation.id} (${violation.nodes.length})`),
    ).toEqual([]);
  }
});

test("fits a phone: no console screen scrolls sideways at 360px", async ({ page }) => {
  const member = await createMember("phone");
  await addLockedProfile(member, "Kitchen");
  await page.setViewportSize({ width: 360, height: 780 });
  await signInToConsole(page, "staff-admin");
  for (const path of [
    "",
    "members",
    `members/${member.accountId}`,
    "plans",
    "content/billboards",
    "content/collections",
    "content/collections/new",
    "content/availability",
    "experiments",
    "experiments/new",
    "operations/health",
    "operations/dead-letters",
    "operations/recommendations",
    "operations/privacy",
    "operations/audit",
  ]) {
    await page.goto(adminPath(path));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path || "overview"} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(
      0,
    );
  }
});
