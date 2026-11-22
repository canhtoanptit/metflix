import { createBareAccount } from "./billing-support.ts";
import { expect, test } from "./fixtures.ts";
import { expectAccessible } from "./member-support.ts";

/**
 * A deployment with no payment provider (`GET /billing/config` answers `none`) says so plainly
 * and offers no checkout that could never finish. Runs only against such a deployment
 * (`WEBFLIX_PAYMENT_PROVIDER=none`); elsewhere it skips with the reason.
 */

test.beforeEach(async ({ page }) => {
  const config = (await (await page.context().request.get("/api/v1/billing/config")).json()) as {
    provider: string;
  };
  test.skip(
    config.provider !== "none",
    `this target's payment provider is ${config.provider}; these checks need provider none`,
  );
});

test("sign-up says plainly that memberships can't be started, and starts no checkout", async ({
  page,
}) => {
  const checkouts: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/v1\/billing\/(checkout|payment-method|promotions)/.test(request.url())) {
      checkouts.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.goto("/signup");
  const notice = page.getByTestId("billing-no-provider");
  await expect(notice).toContainText("Memberships can't be started here right now");
  await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
  await expect(notice.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expectAccessible(page);

  // An account that exists without a membership: the plan and payment steps say the same.
  await createBareAccount(page.context().request, "billing-none");
  await page.goto("/signup");
  await expect(page).toHaveURL(/\/signup\/plan/);
  await expect(page.getByTestId("billing-no-provider")).toBeVisible();
  await page.goto("/signup/payment?plan=basic");
  await expect(page.getByTestId("billing-no-provider")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Continue to payment|Start membership/ }),
  ).toHaveCount(0);
  expect(checkouts).toEqual([]);
});
