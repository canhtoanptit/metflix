/**
 * Account › Privacy against a real API, each test on a fresh account: "Download your data" (a
 * fresh "Confirm it's you", a wait the member can leave and come back to, the download here and
 * in the email) and "Delete your account" (everything said before committing, a cooling-off
 * period with a clear state, keeping the account in one click, and, where the deployment's
 * cooling-off is short, the erasure itself).
 */
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import {
  addProfile,
  createBareAccount,
  freshCard,
  requireFakeProvider,
  subscribe,
} from "./billing-support.ts";
import { expect, test } from "./fixtures.ts";
import { answerIssuer, giveProfile, requireDevIssuer } from "./identity-support.ts";
import { createAccount, expectAccessible, PASSWORD, uniqueEmail } from "./member-support.ts";

/** Confirm it's you when the page asks (a proof younger than five minutes means it doesn't). */
async function confirmIfAsked(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  const asked = await dialog
    .waitFor({ timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (asked) await confirmItsMe(page);
}

/**
 * Every request for the export file: it must be a POST to `/privacy/exports/:id/download` with
 * the token in its body, never a URL that carries the token (privacy review L3).
 */
function watchExportFetches(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/\/api\/v1\/privacy\/exports\/[^/]+(\/download)?$/.test(url.pathname)) return;
    const body = request.postData() ?? "";
    seen.push(
      `${request.method()} ${url.pathname.endsWith("/download") ? "download" : "file"}${url.search}${body.includes('"token"') ? " token-in-body" : ""}`,
    );
  });
  return seen;
}

async function confirmItsMe(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Webflix password").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
}

test("download your data: confirm it's you, wait (or leave and come back), then download it here or from the email", async ({
  page,
  newDevice,
}) => {
  test.setTimeout(120_000);
  const request = page.context().request;
  const account = await createAccount(request, { tag: "export" });
  await page.goto("/account/privacy");
  const section = page.getByRole("region", { name: "Download your data" });
  await expect(section.getByRole("button", { name: "Ask for my data" })).toBeVisible();
  await expect(section).toContainText(account.email);
  await expectAccessible(page);

  await section.getByRole("button", { name: "Ask for my data" }).click();
  await confirmItsMe(page);
  // Either still being prepared, or (a fast dev server) already done; both are honest states.
  await expect(section.getByText(/^(Preparing your data|Your data is ready)$/)).toBeVisible();

  // Leave and come back: the request lives on the server, the page picks it up.
  await page.goto("/browse");
  await page.goto("/account/privacy");
  // Inline exports (dev) finish in seconds; a batch export (Kubernetes, Cloudflare) waits for the
  // deployment's export job. The deployment says how long that normally takes (the privacy
  // terms' exportTypicalSec, what members are told): wait that long and half again, up to five
  // minutes; beyond that the page says it is still preparing, which is all a browser spec can
  // see until the job has run.
  const terms = (
    (await (await request.get("/api/v1/privacy/requests")).json()) as {
      terms?: { exportTypicalSec?: number };
    }
  ).terms;
  const waitMs = Math.min(
    300_000,
    Math.max(60_000, (terms?.exportTypicalSec ?? 0) * 1500 + 30_000),
  );
  test.setTimeout(120_000 + waitMs);
  const ready = section.getByText("Your data is ready");
  try {
    await expect(ready).toBeVisible({ timeout: waitMs });
  } catch (error) {
    const list = (await (await request.get("/api/v1/privacy/requests")).json()) as {
      items: { kind: string; status: string }[];
    };
    const status = list.items.find((item) => item.kind === "export")?.status;
    if (status !== "processing") throw error;
    await expect(section.getByText("Preparing your data")).toBeVisible();
    test.skip(
      true,
      `the export is still processing after ${Math.round(waitMs / 1000)} s: a batch export finishes when the deployment's export job runs (WEBFLIX_EXPORT_EVENTS=batch)`,
    );
  }
  await expectAccessible(page);
  // A button: the token goes in a POST's body, never in a URL. The proof given a moment ago to
  // ask for the copy still holds, so no second "Confirm it's you" (it would be asked otherwise).
  await expect(section.getByRole("link", { name: "Download your data" })).toHaveCount(0);
  const fetches = watchExportFetches(page);
  const download = page.waitForEvent("download");
  await section.getByRole("button", { name: "Download your data" }).click();
  await confirmIfAsked(page);
  const file = await download;
  const document = JSON.parse(await readFile(await file.path(), "utf8")) as {
    format: string;
    account: { email: string };
  };
  expect(document.format).toBe("webflix.data-export");
  expect(document.account.email).toBe(account.email);
  expect(fetches.length).toBeGreaterThan(0);
  for (const fetch of fetches) expect(fetch).toBe("POST download token-in-body");

  // The email links to the app, the token in the fragment (where the deployment has a mailbox
  // to read back): opened on another device, signed out, it asks to sign in, comes back to the
  // same page after signing in and choosing a profile, and downloads the same copy.
  const mailbox = await request.get(
    `/api/v1/diagnostics/mailbox?to=${encodeURIComponent(account.email)}`,
  );
  if (mailbox.status() !== 200) return;
  const items = ((await mailbox.json()) as { items: { template: string; links: string[] }[] })
    .items;
  const mail = items.find((item) => item.template === "data-export-ready");
  expect(mail, "the data-export-ready email").toBeTruthy();
  const emailed = mail?.links.find((link) =>
    /\/account\/privacy\/exports\/[^/#?]+#token=/.test(link),
  );
  expect(emailed, `the email's link (${mail?.links.join(", ")})`).toBeTruthy();
  const link = new URL(emailed ?? "");
  const phone = await newDevice();
  const tab = await phone.newPage();
  await tab.goto(`${link.pathname}${link.hash}`);
  await expect(tab.getByRole("heading", { name: "Sign in to download your data" })).toBeVisible();
  // The token is taken off the address bar (it never reaches a server, a log or history).
  await expect.poll(() => new URL(tab.url()).hash).toBe("");
  await expectAccessible(tab);
  await tab.getByRole("link", { name: "Sign in" }).click();
  await tab.getByLabel("Email address").fill(account.email);
  await tab.getByLabel("Password", { exact: true }).fill(account.password);
  await tab.getByRole("button", { name: "Sign in" }).click();
  await expect(tab.getByRole("heading", { name: "Choose your profile to continue" })).toBeVisible();
  await tab.getByRole("link", { name: "Choose a profile" }).click();
  await tab.getByRole("button", { name: /^Sam/ }).click();
  await expect(tab.getByRole("heading", { name: "Your data is ready" })).toBeVisible();
  const secondFetches = watchExportFetches(tab);
  const second = tab.waitForEvent("download");
  await tab.getByRole("button", { name: "Download your data" }).click();
  // A new session holds no proof: the server asks, and the page asks the member (review L2).
  await confirmItsMe(tab);
  const secondFile = await second;
  const secondDocument = JSON.parse(await readFile(await secondFile.path(), "utf8")) as {
    requestId: string;
  };
  expect(secondDocument.requestId).toBe(decodeURIComponent(link.pathname.split("/").at(-1) ?? ""));
  // Refused for want of a proof, then fetched once confirmed: both POSTs, the token in the body.
  expect(secondFetches.length).toBeGreaterThan(1);
  for (const fetch of secondFetches) expect(fetch).toBe("POST download token-in-body");
  await expect(tab.getByRole("heading", { name: "Your download has started" })).toBeVisible();
});

test("delete your account: said plainly first, scheduled after a cooling-off period, kept in one click", async ({
  page,
}) => {
  const request = page.context().request;
  await createAccount(request, { tag: "delete" });
  await page.goto("/account/privacy");
  const section = page.getByRole("region", { name: "Delete your account" });
  // Everything that matters before the button.
  for (const term of ["When you ask", "What we keep", "Your membership"]) {
    await expect(section.getByText(term, { exact: true })).toBeVisible();
  }
  // What is kept after erasure, every item of it (the list the server keeps).
  await expect(section).toContainText("invoices, payments and refunds");
  await expect(section).toContainText("A record that you asked us to delete your account");
  await expect(section).toContainText("a fingerprint of that card with nothing linking it to you");
  await expect(section).toContainText('showing you as "Erased member", with no email address');

  await section.getByRole("button", { name: "Delete my account" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete your account?" });
  await expect(confirm).toContainText("It will be deleted on");
  // Keeping the account is the dialog's way out.
  await confirm.getByRole("button", { name: "Keep my account" }).click();
  await expect(confirm).toBeHidden();
  await section.getByRole("button", { name: "Delete my account" }).click();
  await confirm.getByRole("button", { name: "Delete my account" }).click();
  await confirmItsMe(page);

  const scheduled = page.getByText(/^Your account will be deleted on /);
  await expect(scheduled).toBeVisible();
  // Coming back: the state is the server's, and it comes first on the page.
  await page.reload();
  await expect(scheduled).toBeVisible();
  const first = page.getByRole("main").getByRole("region").first();
  await expect(first).toHaveAccessibleName("Delete your account");
  await expectAccessible(page);
  const list = (await (await request.get("/api/v1/privacy/requests")).json()) as {
    items: { kind: string; status: string }[];
  };
  expect(list.items.find((item) => item.kind === "deletion")?.status).toBe("scheduled");

  // Keeping it asks for nothing more.
  await page.getByRole("button", { name: "Keep my account" }).click();
  await expect(page.getByText("Your account is staying").first()).toBeVisible();
  await expect(section.getByRole("button", { name: "Delete my account" })).toBeVisible();
  const after = (await (await request.get("/api/v1/privacy/requests")).json()) as {
    items: { kind: string; status: string }[];
  };
  expect(after.items.find((item) => item.kind === "deletion")?.status).toBe("canceled");
});

test("when the cooling-off period ends, the account is gone and this browser is signed out", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const request = page.context().request;
  await createAccount(request, { tag: "erase" });
  await page.goto("/account/privacy");
  const section = page.getByRole("region", { name: "Delete your account" });
  await section.getByRole("button", { name: "Delete my account" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete your account?" })
    .getByRole("button", { name: "Delete my account" })
    .click();
  await confirmItsMe(page);
  await expect(page.getByText(/^Your account will be deleted on /)).toBeVisible();
  const list = (await (await request.get("/api/v1/privacy/requests")).json()) as {
    items: { kind: string; scheduledFor: string | null }[];
  };
  const due = Date.parse(list.items.find((item) => item.kind === "deletion")?.scheduledFor ?? "");
  const wait = due - Date.now();
  test.skip(
    !(wait < 90_000),
    `the cooling-off period is ${Math.round(wait / 1000)} s here (WEBFLIX_DELETION_COOLING_OFF_SEC); the erasure is proven where it is short`,
  );
  // The member comes back after it: the session is gone, the app says so by asking to sign in.
  await expect
    .poll(async () => (await (await request.get("/api/v1/session")).json()).authenticated, {
      timeout: wait + 60_000,
      intervals: [2000],
    })
    .toBe(false);
  await page.goto("/account/privacy");
  await expect(page).toHaveURL(/\/login/);
  // This browser asked for it, so Sign in says what happened.
  await expect(page.getByText("Your account has been deleted")).toBeVisible();
});

test("the browser that asked for a deletion says so at Sign in once it is due, and only that browser", async ({
  page,
  newDevice,
}) => {
  const request = page.context().request;
  const account = await createAccount(request, { tag: "erased-memory" });
  await page.goto("/account/privacy");
  const section = page.getByRole("region", { name: "Delete your account" });
  await section.getByRole("button", { name: "Delete my account" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete your account?" })
    .getByRole("button", { name: "Delete my account" })
    .click();
  await confirmItsMe(page);
  await expect(page.getByText(/^Your account will be deleted on /)).toBeVisible();
  // All it keeps is the date the deletion is due: nothing that names the account.
  const kept = await page.evaluate(() => localStorage.getItem("webflix:deletion-due"));
  expect(kept).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

  // Before the date, Sign in says nothing of it.
  // Signed out on this browser (its storage stays, as after a real sign-out).
  await page.context().clearCookies();
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Your account has been deleted")).toHaveCount(0);

  // Once the date has passed (moved back here, as time would move on), it says the account was
  // deleted as asked, and a failed sign-in offers a new account instead of a reset.
  await page.evaluate(() =>
    localStorage.setItem("webflix:deletion-due", new Date(Date.now() - 60_000).toISOString()),
  );
  await page.reload();
  await expect(page.getByText("Your account has been deleted")).toBeVisible();
  await expect(
    page.getByText(/You asked for it on this browser, and it was deleted on/),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Incorrect email or password");
  await expect(alert).toContainText(/If you meant the account deleted on .+, it no longer exists/);
  await expect(alert.getByRole("link", { name: "create a new account" })).toBeVisible();
  await expect(alert.getByRole("link", { name: /reset/i })).toHaveCount(0);

  // Any other browser knows nothing of it.
  const other = await newDevice();
  const elsewhere = await other.newPage();
  await elsewhere.goto("/login");
  await expect(elsewhere.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(elsewhere.getByText("Your account has been deleted")).toHaveCount(0);
  await other.close();

  // Someone signing in on this browser after the date is another account: it is forgotten.
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  expect(await page.evaluate(() => localStorage.getItem("webflix:deletion-due"))).toBeNull();
});

test("a member without a password confirms at their provider, comes back, and picks up where they left off", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await requireDevIssuer(request, "google");
  const email = uniqueEmail("privacy-oidc");
  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  await expect(page.getByRole("heading", { name: "Welcome to Webflix" })).toBeVisible();
  await giveProfile(page.context().request, "Sam");

  // Download your data: the provider proves it's them, and the request goes ahead on return
  // (asking for a copy changes nothing, so there is nothing to confirm twice).
  await page.goto("/account/privacy");
  const exportSection = page.getByRole("region", { name: "Download your data" });
  await exportSection.getByRole("button", { name: "Ask for my data" }).click();
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toContainText("To download your data, confirm you're the account holder.");
  await prompt.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  await expect(exportSection.getByText(/^(Preparing your data|Your data is ready)$/)).toBeVisible();

  // Delete your account: on return the confirmation is asked again, never acted on alone.
  await page.context().clearCookies({ name: "webflix_session" });
  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
  await page.getByRole("button", { name: /^Sam/ }).click();
  await page.goto("/account/privacy");
  const deletion = page.getByRole("region", { name: "Delete your account" });
  await deletion.getByRole("button", { name: "Delete my account" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete your account?" })
    .getByRole("button", { name: "Delete my account" })
    .click();
  await prompt.getByRole("link", { name: "Continue with Google" }).click();
  await answerIssuer(page, { email });
  const confirmAgain = page.getByRole("alertdialog", { name: "Delete your account?" });
  await expect(confirmAgain).toBeVisible();
  const before = (await (await page.context().request.get("/api/v1/privacy/requests")).json()) as {
    items: { kind: string; status: string }[];
  };
  expect(before.items.some((item) => item.kind === "deletion")).toBe(false);
  await confirmAgain.getByRole("button", { name: "Delete my account" }).click();
  await expect(page.getByText(/^Your account will be deleted on /)).toBeVisible();
});

/** Press Tab until `target` has focus (as a keyboard user would), at most `limit` times. */
async function tabTo(page: Page, target: ReturnType<Page["locator"]>, limit = 40): Promise<void> {
  for (let press = 0; press < limit; press += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("with the keyboard alone: change a choice, schedule the deletion, keep the account", async ({
  page,
}) => {
  const request = page.context().request;
  await createAccount(request, { tag: "privacy-keys" });
  await page.goto("/account/privacy");
  const personalisation = page.getByRole("switch", { name: "Personalized recommendations" });
  await expect(personalisation).toBeVisible();
  const before = await personalisation.getAttribute("aria-checked");
  await tabTo(page, personalisation);
  await page.keyboard.press("Space");
  await expect(personalisation).not.toHaveAttribute("aria-checked", before ?? "");

  await tabTo(page, page.getByRole("button", { name: "Delete my account" }));
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("alertdialog", { name: "Delete your account?" });
  await expect(confirm).toBeVisible();
  await tabTo(page, confirm.getByRole("button", { name: "Delete my account" }), 4);
  await page.keyboard.press("Enter");
  const identity = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(identity.getByLabel("Webflix password")).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Enter");
  // The new state is announced where focus lands.
  const notice = page.getByRole("alert").filter({ hasText: /^Your account will be deleted on / });
  await expect(notice).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Keep my account" }), 4);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Delete my account" })).toBeVisible();
});

test("a deletion stops the renewals, said before and while scheduled; a kept account can resume its membership", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const request = page.context().request;
  await requireFakeProvider(request);
  await createBareAccount(request, "delete-member");
  await subscribe(request, { planId: "standard", card: freshCard("visa") });
  await addProfile(request, "Sam");
  await page.goto("/account/privacy");
  const section = page.getByRole("region", { name: "Delete your account" });
  // Before committing, as a condition (the shared outcome): what deleting today would do.
  await expect(
    section.getByText(
      /If you delete your account today: you can watch until .+\. Nothing more is charged\./,
    ),
  ).toBeVisible();
  await section.getByRole("button", { name: "Delete my account" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete your account?" });
  await expect(confirm).toContainText("Nothing more is charged.");
  await confirm.getByRole("button", { name: "Delete my account" }).click();
  await confirmItsMe(page);
  // While scheduled: what the deletion does to the membership, no way to resume it yet, and
  // focus on the notice that says so.
  const notice = page.locator("#privacy-deletion-scheduled");
  await expect(notice).toContainText("Nothing more is charged.");
  await expect(notice).toBeFocused();
  await expect(page.getByRole("button", { name: "Resume membership" })).toHaveCount(0);
  // Membership says the same as Privacy (UX review 2.1): the deletion date ends it.
  const scheduledFor = (
    (await (await request.get("/api/v1/privacy/requests")).json()) as {
      items: { kind: string; scheduledFor: string }[];
    }
  ).items.find((item) => item.kind === "deletion")?.scheduledFor;
  expect(scheduledFor).toBeTruthy();
  const title = (await notice.locator("p").first().textContent()) ?? "";
  const date = title.replace(/^Your account will be deleted on /, "");
  expect(date).not.toBe(title);
  await page.goto("/account/membership");
  await expect(page.getByRole("main")).toContainText(date);
  await expect(page.getByRole("main")).toContainText("nothing more is charged");
  await page.goto("/account/privacy");
  const session = (await (await request.get("/api/v1/session")).json()) as {
    membership: { cancelAtPeriodEnd: boolean };
  };
  expect(session.membership.cancelAtPeriodEnd).toBe(true);

  // Kept: the membership stays set to end, and one action resumes it, saying the next bill; focus
  // moves to that notice, then to the section's heading once resumed (UX review 2.7).
  await page.getByRole("button", { name: "Keep my account" }).click();
  const resume = page.getByRole("button", { name: "Resume membership" });
  await expect(resume).toBeVisible();
  await expect(page.locator("#privacy-membership-resume")).toBeFocused();
  // In billing's own words (a trial's first payment, or the next renewal).
  await expect(
    page.getByText(/If you resume it: your (first payment, .+, is on|next payment is .+ on) .+\./),
  ).toBeVisible();
  await expectAccessible(page);
  await resume.click();
  await expect(page.getByText("Your membership will continue").first()).toBeVisible();
  await expect(resume).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Delete your account" })).toBeFocused();
  const after = (await (await request.get("/api/v1/session")).json()) as {
    membership: { cancelAtPeriodEnd: boolean };
  };
  expect(after.membership.cancelAtPeriodEnd).toBe(false);
});
