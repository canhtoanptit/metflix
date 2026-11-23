/**
 * Global Privacy Control in a browser that really sends it (docs/BLUEPRINT-M2.md §6.3): Firefox
 * with its "Tell websites not to sell or share my data" setting on, which exposes
 * `navigator.globalPrivacyControl` and sends `Sec-GPC: 1` on every request. Chromium has no such
 * setting and WebKit none either: there the spec skips (an emulated signal would prove only the
 * emulation). Needs an opt-out deployment (`WEBFLIX_CONSENT_MODE=opt-out`), the mode where the
 * signal changes anything: opt-in already collects nothing by default.
 */
import { expect, test } from "./fixtures.ts";
import { createAccount } from "./member-support.ts";
import {
  consentPrompt,
  leavePage,
  readBack,
  readBackUntil,
  recordEventRequests,
  requireMode,
  storedDeviceId,
} from "./privacy-support.ts";

test.use({
  launchOptions: {
    firefoxUserPrefs: {
      "privacy.globalprivacycontrol.enabled": true,
      "privacy.globalprivacycontrol.functionality.enabled": true,
    },
  },
});

const BATCH_WAIT_MS = 16_500;

test("the browser's Global Privacy Control is a no for what the member never answered; their own yes wins", async ({
  page,
  browserName,
}) => {
  test.setTimeout(120_000);
  test.skip(
    browserName !== "firefox",
    "only Firefox has a Global Privacy Control setting a test can turn on",
  );
  await requireMode(page.context().request, "opt-out");
  const request = page.context().request;
  await createAccount(request, { tag: "gpc" });
  const sent = recordEventRequests(page.context());
  await page.goto("/browse");
  expect(
    await page.evaluate(
      () => (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl,
    ),
  ).toBe(true);
  await expect(page.locator('section[aria-roledescription="carousel"]').first()).toBeVisible();
  await page.waitForTimeout(BATCH_WAIT_MS);
  // Nothing collected, so nothing to tell: no notice, no device id, no request.
  await expect(consentPrompt(page)).toHaveCount(0);
  expect(await storedDeviceId(page)).toBeNull();
  expect(sent).toEqual([]);

  // The server saw the browser's header too, and recorded the withdrawal.
  const seen = await page.evaluate(async () => {
    const response = await fetch("/api/v1/privacy/consent", { credentials: "same-origin" });
    return (await response.json()) as {
      gpc: boolean;
      purposes: Record<string, { granted: boolean; source: string | null }>;
    };
  });
  expect(seen.gpc).toBe(true);
  expect(seen.purposes.analytics).toMatchObject({ granted: false, source: "gpc" });

  // Account › Privacy says why, and the member's own yes counts over the signal.
  await page.goto("/account/privacy");
  await expect(
    page.getByText("Your browser sends Global Privacy Control", { exact: true }),
  ).toBeVisible();
  const personalisation = page.getByRole("switch", { name: "Personalised recommendations" });
  await expect(personalisation).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByText("Off because your browser sends Global Privacy Control."),
  ).toHaveCount(2);
  await personalisation.click();
  await expect(personalisation).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/^Turned on by you on /)).toBeVisible();

  await page.goto("/browse");
  await expect(page.locator('section[aria-roledescription="carousel"]').first()).toBeVisible();
  await page.waitForTimeout(2500);
  expect(await storedDeviceId(page)).not.toBeNull();
  await leavePage(page);
  const events = await readBackUntil(request, "impressions after the member's own yes", (items) =>
    items.some((event) => event.type === "impression"),
  );
  for (const event of events.filter((item) => item.type === "impression")) {
    expect(event.subject.consent).toEqual({ analytics: false, personalisation: true });
  }
  expect((await readBack(request)).some((event) => event.type === "consent.change")).toBe(true);
});
