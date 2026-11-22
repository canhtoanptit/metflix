import { expect, test } from "./fixtures.ts";

/**
 * The API reference (`/api/docs`) runs under its own Content-Security-Policy: scripts by nonce,
 * no `eval`. Only a browser can prove the bundle needs nothing the policy forbids, so this loads
 * it and requires zero violations (the fixture also fails the spec on any CSP console report).
 */
test("the API reference renders under its Content-Security-Policy, without a violation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __cspViolations: seen });
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} blocked ${event.blockedURI || "(inline)"}`);
    });
  });
  const response = await page.goto("/api/docs");
  expect(response?.status()).toBe(200);
  const policy = (await response?.allHeaders())?.["content-security-policy"] ?? "";
  expect(policy, "the docs page is served with a policy").toContain("script-src");
  expect(policy).not.toContain("unsafe-eval");

  // The reference itself rendered (operations from the route table), not just its shell.
  await expect(page.getByRole("heading", { name: "Webflix API" }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("/api/v1/auth/login").first()).toBeVisible();
  // Its scripts, styles and any eval have run once the reference rendered; let the page finish
  // loading and go idle before reading what it reported (not "networkidle": a connection the
  // suite's own traffic keeps open says nothing about the policy).
  await page.waitForLoadState("load");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        // WebKit has no requestIdleCallback.
        if ("requestIdleCallback" in window)
          requestIdleCallback(() => resolve(), { timeout: 5_000 });
        else setTimeout(resolve, 500);
      }),
  );
  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
  );
  expect(violations).toEqual([]);
});
