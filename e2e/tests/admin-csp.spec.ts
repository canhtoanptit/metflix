/**
 * The console runs under its own Content-Security-Policy (security review L3), and nothing in
 * it trips that policy. Every document under /admin carries the policy (the Worker and the chart
 * set it; the console's `vite preview` sends the Worker's own, so a preview run shows what a
 * deployment would block), and a journey through the screens, a dialog, title cards, selects and
 * the screen that loads zod reports no violation.
 *
 * Only against a built console (vite preview, a deployment): the dev server's hot reload is
 * inline script by design, and no deployment serves it.
 */

import { ADMIN_URL, adminPath, createMember, signInToConsole } from "./admin-helpers.ts";
import { expect, test } from "./fixtures.ts";

/** The policy's directives, by name. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name = "", ...values]) => [name, values]),
  );
}

test("the console has its own Content-Security-Policy, and trips nothing in it", async ({
  page,
  request,
}) => {
  const index = await request.get(ADMIN_URL);
  test.skip(
    (await index.text()).includes("/@vite/client"),
    "the dev server's hot reload is inline script by design: run against a built console",
  );
  const config = (await (await request.get(new URL("config.json", ADMIN_URL).href)).json()) as {
    issuer: string;
  };
  const issuerOrigin = config.issuer.startsWith("/") ? null : new URL(config.issuer).origin;

  // Every console document carries it: the entry, a deep link, the sign-in callback.
  for (const path of ["", "members", "auth/callback"]) {
    const policy = (await request.get(adminPath(path))).headers()["content-security-policy"];
    expect(policy, `${path || "index"}: no Content-Security-Policy`).toBeTruthy();
    const policyDirectives = directives(policy ?? "");
    expect(policyDirectives.get("script-src")).toEqual(["'self'"]);
    expect(policyDirectives.get("connect-src")).toEqual(
      issuerOrigin ? ["'self'", issuerOrigin] : ["'self'"],
    );
    expect(policyDirectives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policyDirectives.get("object-src")).toEqual(["'none'"]);
    // None of the member app's payment, maps or media origins, nor any https: wildcard.
    expect(policy).not.toMatch(/stripe|google|https:(?!\/\/)/);
  }

  // Each violation is told to the test as it happens (a document's own record would be lost
  // with the next navigation): in the page, as a console message the test collects.
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.info(
        `csp-violation ${JSON.stringify({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          source: `${event.sourceFile}:${event.lineNumber}`,
          sample: event.sample,
        })}`,
      );
    });
  });
  const seen: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("csp-violation ") || /Content Security Policy/i.test(text)) {
      seen.push(`${new URL(page.url()).pathname}: ${text}`);
    }
  });
  const violations = () => [...seen];

  const member = await createMember("csp");
  await signInToConsole(page, "staff-admin", "");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  expect(violations()).toEqual([]);

  // A member's page and a dialog (Radix locks scrolling with a style element of its own).
  await page.goto(adminPath(`members/${member.accountId}`));
  await expect(page.getByRole("heading", { level: 1, name: member.email })).toBeVisible();
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out everywhere" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(violations()).toEqual([]);

  // Title cards (the catalogue's images) in the collection editor.
  await page.goto(adminPath("content/collections/new"));
  const titles = page.getByRole("list", { name: "Titles by name" });
  await expect(titles.locator("img").first()).toBeVisible();
  expect(violations()).toEqual([]);

  // Screens with tables and selects; the privacy jobs load zod (the export results' check),
  // which must not probe for eval; the audit log's details.
  for (const path of [
    "operations/health",
    "operations/privacy",
    "experiments",
    "experiments/new",
    "plans",
    "operations/audit",
  ]) {
    await page.goto(adminPath(path));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  await page.getByRole("combobox", { name: "Show" }).click();
  await page.getByRole("option", { name: "Actions and views" }).click();
  await page
    .getByRole("button", { name: /^Details of / })
    .first()
    .click();

  expect(violations()).toEqual([]);
});
