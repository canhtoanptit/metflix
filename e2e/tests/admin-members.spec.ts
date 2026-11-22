/**
 * Support journeys on a fresh member: find them, see how they stand, remove a profile's PIN,
 * record a consent answer, send a password reset, sign them out everywhere, cancel a scheduled
 * deletion. Each change asks why, and each lands in the audit log under the staff member's name.
 */

import {
  addLockedProfile,
  adminPath,
  createMember,
  scheduleDeletion,
  signInToConsole,
} from "./admin-helpers.ts";
import { CLIENT_HEADERS } from "./api.ts";
import { expect, test } from "./fixtures.ts";

test("support finds a member by email and removes a profile's PIN, with a reason that is audited", async ({
  page,
}) => {
  const member = await createMember("pin");
  await addLockedProfile(member, "Kitchen");
  await signInToConsole(page, "staff-admin", "members");

  // Search by the beginning of the address; the query never goes into the URL.
  await page
    .getByRole("searchbox", { name: "Email or account ID" })
    .fill(member.email.slice(0, 30));
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/admin\/members$/);
  await page.getByRole("link", { name: member.email }).click();
  await expect(page.getByRole("heading", { level: 1, name: member.email })).toBeVisible();
  expect(page.url()).not.toContain("@");
  expect(await page.title()).toBe("Member · Webflix Staff");

  await page.getByRole("button", { name: "Remove PIN from Kitchen" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove the PIN from “Kitchen”" });
  // The reason is required and checked before anything is sent.
  await dialog.getByRole("button", { name: "Remove PIN" }).click();
  await expect(dialog.getByText("Say why, in a few words")).toBeVisible();
  await dialog.getByLabel("Reason").fill("Member forgot the PIN (ticket 4821)");
  const removed = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" && /\/pin$/.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole("button", { name: "Remove PIN" }).click();
  expect((await removed).status()).toBe(204);
  await expect(dialog.getByRole("heading", { name: "Done" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Remove PIN from Kitchen" })).toHaveCount(0);

  const profiles = await member.api.get("/api/v1/profiles");
  const kitchen = (
    (await profiles.json()) as { items: { name: string; isLocked: boolean }[] }
  ).items.find((profile) => profile.name === "Kitchen");
  expect(kitchen?.isLocked).toBe(false);

  // The audit log has it, under this staff member, with the reason.
  await page.goto(adminPath(`operations/audit?targetType=member&targetId=${member.accountId}`));
  const row = page.getByRole("row").filter({ hasText: "member.pin_removed" });
  await expect(row).toBeVisible();
  await expect(row.getByText("Succeeded").filter({ visible: true })).toBeVisible();
  await row.getByRole("button", { name: /Details of member.pin_removed/ }).click();
  await expect(page.getByText("Member forgot the PIN (ticket 4821)").first()).toBeVisible();
});

test("support records consent, sends a reset, signs the member out everywhere", async ({
  page,
}) => {
  const member = await createMember("support");
  await signInToConsole(page, "staff-support", `members/${member.accountId}`);
  await expect(page.getByRole("heading", { level: 1, name: member.email })).toBeVisible();
  // Billing actions are not offered to a support-only agent.
  await expect(page.getByRole("button", { name: "Cancel membership" })).toHaveCount(0);

  // Privacy is a separate, audited read: loaded only when asked for.
  await page.getByRole("button", { name: "Show privacy details" }).click();
  await page.getByRole("button", { name: "Record consent answer" }).click();
  const consent = page.getByRole("dialog", { name: "Record a consent answer" });
  await consent.getByRole("radio", { name: "Withdrawn" }).check();
  await consent.getByLabel("Reason").fill("Member asked on the phone to stop analytics");
  await consent.getByRole("button", { name: "Record answer" }).click();
  await expect(
    consent.getByText("Analytics: withdrawn, recorded as given to support."),
  ).toBeVisible();
  await consent.getByRole("button", { name: "Close" }).click();
  const state = (await (await member.api.get("/api/v1/privacy/consent")).json()) as {
    purposes: { analytics: { granted: boolean; source: string } };
  };
  expect(state.purposes.analytics).toMatchObject({ granted: false, source: "support" });

  await page.getByRole("button", { name: "Send password reset" }).click();
  const reset = page.getByRole("dialog", { name: "Send a password reset" });
  await reset.getByLabel("Reason").fill("Locked out, verified identity on the call");
  await reset.getByRole("button", { name: "Send the email" }).click();
  await expect(reset.getByRole("heading", { name: "Done" })).toBeVisible();
  await reset.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const signOut = page.getByRole("dialog", { name: "Sign out everywhere" });
  await signOut.getByLabel("Reason").fill("Lost phone");
  await signOut.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(signOut.getByRole("heading", { name: "Done" })).toBeVisible();
  const session = (await (await member.api.get("/api/v1/session")).json()) as {
    authenticated: boolean;
  };
  expect(session.authenticated).toBe(false);
});

test("support cancels a scheduled account deletion", async ({ page }) => {
  const member = await createMember("deletion");
  await scheduleDeletion(member);
  await signInToConsole(page, "staff-support", `members/${member.accountId}`);
  await page.getByRole("button", { name: "Show privacy details" }).click();
  await expect(page.getByText("Account deletion")).toBeVisible();
  await expect(page.getByText("Scheduled")).toBeVisible();
  await page.getByRole("button", { name: "Cancel deletion" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel the account deletion" });
  await dialog.getByLabel("Reason").fill("Member changed their mind on the call");
  await dialog.getByRole("button", { name: "Cancel deletion" }).click();
  await expect(dialog.getByText("The deletion is cancelled. The account stays.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Canceled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel deletion" })).toHaveCount(0);
  const requests = (await (
    await member.api.get("/api/v1/privacy/requests", { headers: CLIENT_HEADERS })
  ).json()) as { items: { kind: string; status: string }[] };
  expect(requests.items.find((request) => request.kind === "deletion")?.status).toBe("canceled");
});

test("an unknown account id and an empty search say so plainly", async ({ page }) => {
  await signInToConsole(page, "staff-support", "members/01a20000-0000-7000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "No member with this account ID" })).toBeVisible();
  await page.goto(adminPath("members"));
  await page.getByRole("button", { name: "Search" }).click();
  await expect(
    page.getByText("Enter an email address, the beginning of one, or an account ID."),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Email or account ID" })
    .fill("nobody-at-all-xyz@nowhere.invalid");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("heading", { name: "No member matches" })).toBeVisible();
});

test("a support agent follows an unclear action to their own entry, which says how it ended", async ({
  page,
}) => {
  const member = await createMember("follow-up");
  // The request reaches the service and acts; its answer is lost on the way back (a 503 here).
  await page.route(/\/api\/admin\/v1\/members\/[^/]+\/sign-out$/, async (route) => {
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "urn:webflix:problem:service_unavailable",
        title: "Service temporarily unavailable",
        status: 503,
        code: "service_unavailable",
      }),
    });
  });
  const sent = page.waitForRequest(/\/sign-out$/);
  await signInToConsole(page, "staff-support", `members/${member.accountId}`);
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out everywhere" });
  await dialog.getByLabel("Reason").fill("Lost phone");
  await dialog.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(dialog.getByRole("heading", { name: "Outcome unknown" })).toBeVisible();
  const requestId = (await sent).headers()["x-request-id"] ?? "";
  // Without the admin role the audit log is closed, but their own actions are not.
  await dialog.getByRole("link", { name: "Open it in your actions" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your actions" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/admin/activity\\?requestId=${requestId}$`));
  const entry = page.getByRole("row").filter({ hasText: "member.signed_out_everywhere" });
  await expect(entry).toHaveCount(1);
  await expect(entry.getByText("Succeeded")).toBeVisible();
  // So the member was signed out after all: nothing to do again.
  const session = (await (await member.api.get("/api/v1/session")).json()) as {
    authenticated: boolean;
  };
  expect(session.authenticated).toBe(false);

  // The overview lists their own actions that need following up, not everybody's.
  await page.getByRole("link", { name: "Overview" }).first().click();
  await expect(page.getByRole("region", { name: "Your actions to follow up" })).toBeVisible();
});
