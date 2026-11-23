import type { APIRequestContext } from "@playwright/test";
import { CLIENT_HEADERS } from "./api.ts";
import {
  addProfile,
  createBareAccount,
  freshCard,
  requireFakeProvider,
  subscribe,
} from "./billing-support.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Billing's per-account limits (promo-code lookups; checkout starts, plan previews and card
 * setups) never strand a member and never silently take something away: each refusal says what
 * happened and when to try again, and nothing the member had is dropped because of it.
 */

test.beforeEach(async ({ page }) => {
  await requireFakeProvider(page.context().request);
});

/** Send `send` until the server answers 429 (or `max` times); returns how many went through. */
async function spendUntilRefused(
  send: (index: number) => Promise<{ status(): number }>,
  max: number,
): Promise<number> {
  for (let index = 0; index < max; index += 1) {
    if ((await send(index)).status() === 429) return index;
  }
  throw new Error(`no 429 after ${max} requests`);
}

function spendCodeLookups(request: APIRequestContext): Promise<number> {
  return spendUntilRefused(
    (index) =>
      request.post("/api/v1/billing/promotions/validate", {
        headers: CLIENT_HEADERS,
        data: { code: `NOSUCHCODE${index}`, planId: "basic" },
      }),
    30,
  );
}

test("a code on the checkout survives a reload with the code budget spent, and a refused removal says so", async ({
  page,
}) => {
  const request = page.context().request;
  await createBareAccount(request, "billing-limit-code");
  const start = await request.post("/api/v1/billing/checkout", {
    headers: CLIENT_HEADERS,
    data: { planId: "standard", promotionCode: "WEBFLIX50" },
  });
  expect(start.status(), await start.text()).toBe(201);
  await spendCodeLookups(request);

  const kept = page.getByText(/WEBFLIX50 (stays yours|applied)/);
  await page.goto("/signup/payment?plan=standard");
  await expect(kept).toBeVisible();
  await page.reload();
  await expect(kept).toBeVisible();

  // Now the other budget: removing the code restarts the checkout, which is refused.
  await spendUntilRefused(
    () =>
      request.post("/api/v1/billing/checkout", {
        headers: CLIENT_HEADERS,
        data: { planId: "standard", promotionCode: "WEBFLIX50" },
      }),
    60,
  );
  await page.getByRole("button", { name: "Remove promo code" }).click();
  await expect(page.getByRole("alert")).toContainText(
    /We couldn't remove WEBFLIX50: Too many attempts just now\. Try again in \d+ seconds?\. It's still applied\./,
  );
  await expect(kept).toBeVisible();
});

test("applying a code with the code budget spent says so, with when to try again", async ({
  page,
}) => {
  const request = page.context().request;
  await createBareAccount(request, "billing-limit-apply");
  await spendCodeLookups(request);
  await page.goto("/signup/payment?plan=standard");
  await page.getByRole("button", { name: "Have a promo code?" }).click();
  const code = page.getByRole("textbox", { name: "Promo code" });
  await code.fill("WEBFLIX50");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(code).toHaveAccessibleDescription(
    /Too many codes tried\. Try again in \d+ seconds?\./,
  );
  await expect(code).toBeFocused();
});

test("a refused plan preview offers Try again once Retry-After has passed", async ({ page }) => {
  const request = page.context().request;
  await createBareAccount(request, "billing-limit-preview");
  await subscribe(request, { planId: "standard", card: freshCard() });
  await addProfile(request);
  await spendUntilRefused(
    () =>
      request.post("/api/v1/billing/subscription/preview", {
        headers: CLIENT_HEADERS,
        data: { planId: "basic" },
      }),
    60,
  );
  await page.goto("/account/membership/plan");
  await page.getByRole("radio", { name: /Basic/ }).click();
  await expect(page.getByText("We couldn't work out the cost of this change")).toBeVisible();
  const retry = page.getByRole("button", { name: /^Try again in \d+s$/ });
  await expect(retry).toBeDisabled();
  await expect(page.getByRole("link", { name: "Keep Standard" })).toBeVisible();
});
