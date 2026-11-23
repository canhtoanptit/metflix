/**
 * Consent and telemetry in a real browser against a real API (docs/BLUEPRINT-M2.md §6.3), each
 * test on a fresh account. What the browser sends is observed at the network (`POST /events`)
 * while the page is open, what the server kept through the events read-back, and whether the
 * browser keeps a device id at all (the SDK writes one the moment it exists: none means nothing
 * could be queued or sent).
 *
 * - opt-in: nothing leaves the browser, and no device id is stored, before an answer; the prompt
 *   waits, does not move the page, and refusing is as easy as accepting (keyboard included);
 * - after "Allow", impressions carry their positions, and leaving the page sends what waited;
 * - a kids profile sends nothing, even on an account that said yes;
 * - withdrawing consent, switching profile and signing out each drop what was waiting.
 */
import { createProfile, selectProfile } from "./api.ts";
import { expect, test } from "./fixtures.ts";
import { createAccount, expectAccessible, signIn } from "./member-support.ts";
import {
  answer,
  consentOf,
  consentPrompt,
  leavePage,
  navigateInApp,
  readBack,
  readBackUntil,
  recordEventRequests,
  requireMode,
  storedDeviceId,
} from "./privacy-support.ts";

/** Long enough for visible cards to pass their one-second dwell (the product's own timing). */
const DWELL_MS = 2500;
/**
 * Longer than the app's batch interval (15 s): anything queued would have been sent by then,
 * while the page is open, where the browser's requests can be observed. (A request sent as the
 * page is left, with keepalive, is not observable from Playwright: the server's read-back is the
 * witness for those.)
 */
const BATCH_WAIT_MS = 16_500;

test.describe("opt-in deployment", () => {
  test.beforeEach(async ({ page }) => {
    await requireMode(page.context().request, "opt-in");
  });

  test("nothing leaves the browser before an answer; the prompt waits, and refusing takes one key", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const request = page.context().request;
    await createAccount(request, { tag: "consent-refuse" });
    const sent = recordEventRequests(page.context());
    await page.goto("/browse");
    const prompt = consentPrompt(page);
    await expect(prompt).toBeVisible();
    // Over the page, never in its flow: nothing moves when it appears.
    expect(await prompt.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
    // The page behind it is usable, and cards stay on screen past their dwell and a batch.
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(BATCH_WAIT_MS);
    expect(sent, "POST /events before an answer").toEqual([]);
    expect(await storedDeviceId(page), "a device id before an answer").toBeNull();
    await expectAccessible(page);

    // Keyboard: after the skip link, the prompt is the first stop.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(prompt.getByRole("button", { name: "Decide later" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(prompt.getByRole("link", { name: "Account › Privacy" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(prompt.getByRole("button", { name: "Allow", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(prompt.getByRole("button", { name: "Don't allow" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(prompt).toBeHidden();
    await expect(page.getByText("Your choice is saved", { exact: true }).first()).toBeVisible();
    // The prompt is gone; focus is on the page it stood in front of (UX review 2.7).
    await expect(page.locator("main")).toBeFocused();

    const consent = await consentOf(request);
    expect(consent.promptRequired).toBe(false);
    expect(consent.purposes.analytics).toMatchObject({ granted: false, source: "banner" });
    expect(consent.purposes.personalisation).toMatchObject({ granted: false, source: "banner" });
    expect(await storedDeviceId(page)).toBeNull();
    await leavePage(page);
    expect(sent).toEqual([]);
    const kept = await readBack(request);
    expect(kept.filter((event) => event.source === "client")).toEqual([]);

    // Answered: the prompt does not come back.
    await page.goto("/browse");
    await expect(page.locator('section[aria-roledescription="carousel"]').first()).toBeVisible();
    await page.waitForTimeout(2000);
    await expect(prompt).toHaveCount(0);
  });

  test("the prompt stays out of the way: room is kept for it, a dialog hides it, and it shows only on the browsing pages", async ({
    page,
  }) => {
    const request = page.context().request;
    await createAccount(request, { tag: "consent-place" });
    await page.goto("/browse");
    const prompt = consentPrompt(page);
    await expect(prompt).toBeVisible();

    // Room at the end of the page: scrolled to the bottom, the page's last content is above it
    // (on a phone, where the prompt is tallest and sits above the tab bar).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(prompt).toBeVisible();
    const panel = prompt.locator(":scope > div");
    for (let pass = 0; pass < 3; pass += 1) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(600); // lazy rows mount as the page is scrolled
    }
    const lastContentBottom = await page.evaluate(() => {
      const main = document.querySelector("main");
      const boxes = Array.from(main?.querySelectorAll("a, button") ?? []).map((element) =>
        element.getBoundingClientRect(),
      );
      return Math.max(...boxes.filter((box) => box.height > 0).map((box) => box.bottom));
    });
    const panelBox = await panel.boundingBox();
    expect(lastContentBottom, "the page's last control, scrolled to the end").toBeLessThanOrEqual(
      (panelBox?.y ?? 0) + 1,
    );
    const reserved = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.body).paddingBottom),
    );
    expect(reserved).toBeGreaterThanOrEqual(panelBox?.height ?? Number.POSITIVE_INFINITY);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.scrollTo(0, 0));

    // A dialog over the page: the prompt is hidden, and Tab never reaches it.
    await page.locator("[data-row-rank] li a[href*='title=']").first().click();
    const dialog = page.getByRole("dialog").first();
    await expect(dialog).toBeVisible();
    // Hidden on screen, not only to assistive technology (which the dialog already does).
    const drawn = page.locator("section", { hasText: "Your viewing data, your choice" });
    await expect(drawn).toBeHidden();
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press("Tab");
      const inPrompt = await page.evaluate(() =>
        Boolean(
          document.activeElement
            ?.closest("section")
            ?.textContent?.includes("Your viewing data, your choice"),
        ),
      );
      expect(inPrompt, "focus reached the prompt under a dialog").toBe(false);
    }
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect(dialog).toBeHidden();
    await expect(drawn).toBeVisible();

    // Not on the account pages, the gate or anywhere else that is not browsing.
    for (const path of ["/account/security", "/account/privacy", "/profiles/manage", "/account"]) {
      await navigateInApp(page, path);
      await expect(page.getByRole("main")).toBeVisible();
      await page.waitForTimeout(1600); // past the prompt's settle delay
      await expect(prompt, path).toHaveCount(0);
    }
  });

  test("after Allow, impressions carry their positions, and leaving the page sends them", async ({
    page,
  }) => {
    const request = page.context().request;
    await createAccount(request, { tag: "consent-allow" });
    await page.goto("/browse");
    await consentPrompt(page).getByRole("button", { name: "Allow", exact: true }).click();
    await expect(consentPrompt(page)).toBeHidden();
    const sent = recordEventRequests(page.context());
    const allowedAt = Date.now();
    await page.waitForTimeout(DWELL_MS);
    expect(await storedDeviceId(page)).not.toBeNull();
    // Batches go out every 15 s: nothing has been sent while the page was open.
    expect(sent).toEqual([]);
    await leavePage(page);
    // So what the server has now was sent as the page was hidden and unloaded.
    const events = await readBackUntil(request, "impressions sent as the page was left", (items) =>
      items.some((event) => event.type === "impression"),
    );
    expect(Date.now() - allowedAt).toBeLessThan(15_000);
    const impressions = events.filter((event) => event.type === "impression");
    for (const event of impressions) {
      expect(event.context.surface).toBe("home");
      expect(event.context.rowRank).toBeGreaterThanOrEqual(1);
      expect(event.context.rank).toBeGreaterThanOrEqual(1);
      expect(event.context.policy).not.toBeNull();
      expect(event.subject.consent).toEqual({ analytics: true, personalisation: true });
      expect(event.app.platform).toBe("web");
    }
  });
});

test("a kids profile sends nothing at all, even on an account that said yes", async ({ page }) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const mode = (await consentOf(request)).mode;
  test.skip(mode === "off", "consent mode off: nothing is collected from anyone");
  const account = await createAccount(request, { tag: "kids-silent" });
  await answer(request, { analytics: true, personalisation: true });
  const kidsId = await createProfile(request, { name: "Kid", isKids: true });
  await selectProfile(request, kidsId);
  const sent = recordEventRequests(page.context());
  await page.goto("/browse");
  await expect(page.locator('section[aria-roledescription="carousel"]').first()).toBeVisible();
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(BATCH_WAIT_MS);
  await expect(consentPrompt(page)).toHaveCount(0);
  expect(sent, "POST /events from a kids profile").toEqual([]);
  expect(await storedDeviceId(page), "a device id kept for a kids profile").toBeNull();
  await leavePage(page);

  // The same account and page on the adult profile does send: the silence above is the rule.
  await selectProfile(request, account.profileId);
  await page.goto("/browse");
  await page.waitForTimeout(DWELL_MS);
  expect(await storedDeviceId(page)).not.toBeNull();
  await leavePage(page);
  await readBackUntil(request, "the adult profile's impressions", (items) =>
    items.some((event) => event.type === "impression"),
  );
});

test("turning everything off in Account drops what was waiting to be sent, at once", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const mode = (await consentOf(request)).mode;
  test.skip(mode === "off", "consent mode off: nothing is collected from anyone");
  await createAccount(request, { tag: "withdraw" });
  await answer(request, { analytics: true, personalisation: true });
  const sent = recordEventRequests(page.context());
  await page.goto("/browse");
  await expect(page.locator('section[aria-roledescription="carousel"]').first()).toBeVisible();
  await page.waitForTimeout(DWELL_MS);
  // Collecting: impressions are waiting for the next batch (every 15 s).
  expect(await storedDeviceId(page)).not.toBeNull();
  expect(sent).toEqual([]);

  await navigateInApp(page, "/account/privacy");
  const personalisation = page.getByRole("switch", { name: "Personalised recommendations" });
  const analytics = page.getByRole("switch", { name: "Improving Webflix" });
  // The switch keeps focus while it saves, and is never disabled under the member's hand (UX
  // review 2.7): the save is held for a moment so that state can be seen.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/privacy/consent", async (route) => {
    if (route.request().method() === "PUT") await held;
    await route.continue();
  });
  await personalisation.click();
  await expect(page.getByText("Saving…")).toBeVisible();
  await expect(personalisation).toBeFocused();
  await expect(personalisation).toBeEnabled();
  release();
  await expect(page.getByText("Saving…")).toHaveCount(0);
  await page.unroute("**/api/v1/privacy/consent");
  await expect(personalisation).toBeFocused();
  await expect(personalisation).toHaveAttribute("aria-checked", "false");
  await analytics.focus();
  await page.keyboard.press("Space");
  await expect(analytics).toHaveAttribute("aria-checked", "false");
  await expect(analytics).toBeFocused();
  await expect(page.getByText(/^Turned off by you on /)).toHaveCount(2);
  // Nothing of the device is kept once nothing is collected.
  expect(await storedDeviceId(page)).toBeNull();
  await expectAccessible(page);
  // Past the batch the impressions were waiting for: they never went.
  await page.waitForTimeout(BATCH_WAIT_MS);
  expect(sent, "POST /events after everything was turned off").toEqual([]);
  await leavePage(page);
  const kept = await readBack(request);
  expect(kept.filter((event) => event.source === "client")).toEqual([]);
});

test("switching profile never sends one profile's waiting events as the other's", async ({
  page,
}) => {
  const request = page.context().request;
  const mode = (await consentOf(request)).mode;
  test.skip(mode === "off", "consent mode off: nothing is collected from anyone");
  await createAccount(request, { tag: "switch", profileName: "Ana" });
  await answer(request, { analytics: true, personalisation: true });
  const robin = await createProfile(request, { name: "Robin" });
  const sent = recordEventRequests(page.context());
  await page.goto("/browse");
  await expect(page.locator('section[aria-roledescription="carousel"]').first()).toBeVisible();
  await page.waitForTimeout(DWELL_MS);
  expect(sent).toEqual([]);
  const device = await storedDeviceId(page);
  expect(device).not.toBeNull();

  const switchedAt = Date.now();
  await navigateInApp(page, "/profiles");
  await page.getByRole("button", { name: "Robin" }).click();
  await expect(page.locator('section[aria-roledescription="carousel"]').first()).toBeVisible();
  await page.waitForTimeout(DWELL_MS);
  // One account, one device: a profile switch keeps the device id.
  expect(await storedDeviceId(page)).toBe(device);
  await leavePage(page);

  // Everything the server holds as Robin's happened on Robin's profile: Ana's waiting
  // impressions, had they been sent after the switch, would be stamped as Robin's.
  const robins = await readBackUntil(
    request,
    "Robin's impressions",
    (items) => items.some((event) => event.type === "impression"),
    { query: { profileId: robin } },
  );
  for (const event of robins.filter((item) => item.source === "client")) {
    expect(Date.parse(event.occurredAt), `${event.type} from before the switch`).toBeGreaterThan(
      switchedAt,
    );
  }
});

test("signing out drops what was waiting to be sent, and the next account gets a new device id", async ({
  page,
  playwright,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const mode = (await consentOf(request)).mode;
  test.skip(mode === "off", "consent mode off: nothing is collected from anyone");
  const account = await createAccount(request, { tag: "signout" });
  await answer(request, { analytics: true, personalisation: true });
  const sent = recordEventRequests(page.context());
  await page.goto("/browse");
  await expect(page.locator('section[aria-roledescription="carousel"]').first()).toBeVisible();
  await page.waitForTimeout(DWELL_MS);
  expect(sent).toEqual([]);
  const device = await storedDeviceId(page);
  expect(device).not.toBeNull();
  await navigateInApp(page, "/logout");
  await expect(page.getByRole("heading", { name: /signed out/i })).toBeVisible();
  // Past the batch the member's impressions were waiting for.
  await page.waitForTimeout(BATCH_WAIT_MS);
  expect(
    sent.flatMap((batch) => batch.events).filter((event) => event.type === "impression"),
    "the member's impressions, sent after signing out",
  ).toEqual([]);
  await leavePage(page);
  // Read back as the account, from another device.
  const other = await playwright.request.newContext({ baseURL });
  try {
    await signIn(other, account, account.profileId);
    const kept = await readBack(other);
    expect(kept.filter((event) => event.type === "impression")).toEqual([]);
  } finally {
    await other.dispose();
  }

  // Another member signs in on this browser and says yes: their activity is not tied to the
  // last member's device id (UX review 2.11, privacy review L4).
  await createAccount(request, { tag: "signout-next" });
  await answer(request, { analytics: true, personalisation: true });
  await page.goto("/browse");
  await expect(page.locator('section[aria-roledescription="carousel"]').first()).toBeVisible();
  await page.waitForTimeout(DWELL_MS);
  const next = await storedDeviceId(page);
  expect(next).not.toBeNull();
  expect(next).not.toBe(device);
});
