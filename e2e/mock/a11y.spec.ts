import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { gotoAs, type MockSession } from "./support.ts";

/** axe in a real browser, including colour contrast (which jsdom cannot evaluate). */
const PAGES: Array<[string, MockSession, string]> = [
  ["/", "anonymous", "landing"],
  ["/login", "anonymous", "sign in"],
  ["/profiles", "account", "profile gate"],
  ["/browse", "profile", "browse"],
  ["/dev/reference", "profile", "reference"],
];

for (const [path, session, name] of PAGES) {
  test(`${name} has no WCAG 2.2 AA violations`, async ({ page }) => {
    await gotoAs(page, path, session);
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      // The mock toolbar is development chrome, not product UI.
      .exclude('[data-testid="dev-toolbar"]')
      .analyze();
    const summary = results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.nodes
          .map((node) => node.target.join(" "))
          .slice(0, 4)
          .join(" | ")}`,
    );
    expect(summary).toEqual([]);
  });
}
