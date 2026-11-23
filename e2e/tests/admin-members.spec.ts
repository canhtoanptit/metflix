/**
 * Support journeys on a fresh member: find them, see how they stand, remove a profile's PIN,
 * record a consent withdrawal (never a grant: that is the member's own), send a password reset,
 * sign them out everywhere, cancel a scheduled deletion, see a deletion in progress. Each change
 * asks why, and each lands in the audit log under the staff member's name, readable at a glance
 * and reachable from the action's own "Done".
 */

import {
  addLockedProfile,
  adminPath,
  createMember,
  paidMember,
  scheduleDeletion,
  signInToConsole,
  staffCall,
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

  // The audit log has it, in words, under this staff member, with the reason; views of the
  // member's record are out of the way unless asked for.
  await page.goto(adminPath(`operations/audit?targetType=member&targetId=${member.accountId}`));
  const row = page.getByRole("row").filter({ hasText: "Removed a profile PIN" });
  await expect(row).toBeVisible();
  await expect(row.getByText(`Member · ${member.email}`)).toBeVisible();
  await expect(row.getByText("Succeeded").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Viewed a member" })).toHaveCount(0);
  await row.getByRole("button", { name: /Details of Removed a profile PIN/ }).click();
  await expect(page.getByText("Member forgot the PIN (ticket 4821)").first()).toBeVisible();
  await expect(page.getByText("member.pin_removed")).toBeVisible();
  // Asked for, the views are there too.
  await page.getByRole("combobox", { name: "Show" }).click();
  await page.getByRole("option", { name: "Actions and views" }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/show=all/);
  await expect(page.getByRole("row").filter({ hasText: "Viewed a member" }).first()).toBeVisible();
});

test("an action's Done leads straight to its audit entry, in words", async ({ page }) => {
  const member = await createMember("done-link");
  await addLockedProfile(member, "Study");
  await signInToConsole(page, "staff-admin", `members/${member.accountId}`);
  await page.getByRole("button", { name: "Remove PIN from Study" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove the PIN from “Study”" });
  await dialog.getByLabel("Reason").fill("Member forgot the PIN (ticket 5150)");
  const sent = page.waitForRequest(
    (request) => request.method() === "DELETE" && /\/pin$/.test(request.url()),
  );
  await dialog.getByRole("button", { name: "Remove PIN" }).click();
  await expect(dialog.getByRole("heading", { name: "Done" })).toBeVisible();
  const requestId = (await sent).headers()["x-request-id"] ?? "";
  await dialog.getByRole("link", { name: "See it in the audit log" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/admin/operations/audit\\?requestId=${requestId}$`));
  // The URL carries the request id, never the member's address; the row names them.
  expect(page.url()).not.toContain("@");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /^Details of Removed a profile PIN/ }) });
  await expect(row).toHaveCount(1);
  await expect(row.getByText(`Member · ${member.email}`)).toBeVisible();
  // Opened at once, with the reason.
  await expect(page.getByText("Member forgot the PIN (ticket 5150)").first()).toBeVisible();
  // Coming back to the member, the action is settled and forgotten: a fresh page.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: member.email })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("support records a consent withdrawal (never a grant), sends a reset, signs the member out everywhere", async ({
  page,
}) => {
  const member = await createMember("support");
  // The member turned analytics on themselves, and personalisation off.
  for (const [purpose, granted] of [
    ["analytics", true],
    ["personalisation", false],
  ] as const) {
    const answered = await member.api.put("/api/v1/privacy/consent", {
      headers: CLIENT_HEADERS,
      data: { purpose, granted, source: "settings" },
    });
    expect(answered.status(), `consent: ${await answered.text()}`).toBe(200);
  }
  await signInToConsole(page, "staff-support", `members/${member.accountId}`);
  await expect(page.getByRole("heading", { level: 1, name: member.email })).toBeVisible();

  // Privacy is a separate, audited read: loaded only when asked for.
  await page.getByRole("button", { name: "Show privacy details" }).click();
  const privacy = page.getByRole("region", { name: "Privacy" });
  await expect(privacy.getByText("by the member, in Account › Privacy").first()).toBeVisible();
  await page.getByRole("button", { name: "Record a withdrawal" }).click();
  const consent = page.getByRole("dialog", { name: "Record a consent withdrawal" });
  // Only what staff may do is offered, and the dialog says why the other way is the member's.
  await expect(consent.getByText("Only the member can turn a purpose on")).toBeVisible();
  await expect(consent.getByRole("radio")).toHaveCount(0);
  await expect(consent.getByText("Analytics", { exact: true })).toBeVisible();
  await consent.getByLabel("Reason").fill("Member asked on the phone to stop analytics");
  await consent.getByRole("button", { name: "Withdraw analytics" }).click();
  await expect(
    consent.getByText(/^Analytics is off, recorded as asked through support/),
  ).toBeVisible();
  await consent.getByRole("button", { name: "Close" }).click();
  const state = (await (await member.api.get("/api/v1/privacy/consent")).json()) as {
    purposes: { analytics: { granted: boolean; source: string } };
  };
  expect(state.purposes.analytics).toMatchObject({ granted: false, source: "support" });
  // Nothing left to withdraw: no control, and the reason in words.
  await expect(page.getByRole("button", { name: "Record a withdrawal" })).toHaveCount(0);
  await expect(
    privacy.getByText(
      "Both purposes are off, so there is nothing to withdraw. Only the member can turn one on, in Account › Privacy.",
    ),
  ).toBeVisible();
  // The staff API refuses a grant whatever a client sends.
  const grant = await staffCall(
    "staff-support",
    "PUT",
    `/members/${member.accountId}/privacy/consent`,
    {
      purpose: "analytics",
      granted: true,
      reason: "e2e: a grant must be refused",
    },
  );
  expect(grant.status).toBe(403);
  expect(grant.json).toMatchObject({ code: "consent_grant_member_only" });

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

test("support sees the billing actions they can't use, with the role each needs", async ({
  page,
}) => {
  const member = await paidMember("support-billing");
  const billingCalls: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/api\/admin\/v1\/members\/[^/]+\/(billing|refunds|subscription|trial|complimentary)/.test(
        request.url(),
      )
    ) {
      billingCalls.push(request.url());
    }
  });
  await signInToConsole(page, "staff-support", `members/${member.accountId}`);
  await expect(page.getByRole("heading", { level: 1, name: member.email })).toBeVisible();
  const membership = page.getByRole("region", { name: "Membership" });
  for (const name of ["Give free time", "Cancel membership"]) {
    const action = membership.getByRole("button", { name });
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute("aria-disabled", "true");
    await expect(action).toHaveAccessibleDescription(/These need the Billing role/);
  }
  // Reached by keyboard, read out with its reason, and pressing it opens nothing.
  await membership.getByRole("button", { name: "Cancel membership" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const refund = page
    .getByRole("region", { name: "Invoices" })
    .getByRole("button", { name: /^Refund invoice/ })
    .first();
  await expect(refund).toHaveAttribute("aria-disabled", "true");
  await expect(refund).toHaveAccessibleDescription(/Refunds need the Billing role/);
  await refund.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(billingCalls).toEqual([]);
  // The membership line says each thing once.
  await expect(membership.getByText(/^Yes · \d screens? at a time/)).toBeVisible();
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
  await expect(dialog.getByText(/the member gets an email saying so/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel deletion" }).click();
  await expect(
    dialog.getByText(
      "The deletion is cancelled: the account stays, and an email tells the member so.",
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Canceled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel deletion" })).toHaveCount(0);
  const requests = (await (
    await member.api.get("/api/v1/privacy/requests", { headers: CLIENT_HEADERS })
  ).json()) as { items: { kind: string; status: string }[] };
  expect(requests.items.find((request) => request.kind === "deletion")?.status).toBe("canceled");
});

test("a deletion being carried out can't be cancelled, and the page says what is happening", async ({
  page,
}) => {
  const member = await createMember("erasing");
  await scheduleDeletion(member);
  // The erasure's start is a moment the dev API rarely shows (it finishes within a tick): the
  // real answer, with its deletion turned to `processing` as the erasure sets it.
  await page.route(/\/api\/admin\/v1\/members\/[^/]+\/privacy$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      requests: { kind: string; status: string }[];
    };
    for (const request of body.requests) {
      if (request.kind === "deletion") request.status = "processing";
    }
    await route.fulfill({ response, json: body });
  });
  await signInToConsole(page, "staff-support", `members/${member.accountId}`);
  await page.getByRole("button", { name: "Show privacy details" }).click();
  const privacy = page.getByRole("region", { name: "Privacy" });
  await expect(privacy.getByText("This account is being deleted")).toBeVisible();
  await expect(privacy.getByText(/can no longer be kept/)).toBeVisible();
  await expect(privacy.getByText("Being erased")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel deletion" })).toHaveCount(0);
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
  const entry = page.getByRole("row").filter({ hasText: "Signed out everywhere" });
  await expect(entry).toHaveCount(1);
  await expect(entry.getByText("Succeeded")).toBeVisible();
  // A support agent may see members, so the entry names this one by address.
  await expect(entry.getByText(`Member · ${member.email}`)).toBeVisible();
  // So the member was signed out after all: nothing to do again.
  const session = (await (await member.api.get("/api/v1/session")).json()) as {
    authenticated: boolean;
  };
  expect(session.authenticated).toBe(false);

  // The overview lists their own actions that need following up, not everybody's.
  await page.getByRole("link", { name: "Overview" }).first().click();
  await expect(page.getByRole("region", { name: "Your actions to follow up" })).toBeVisible();
});
