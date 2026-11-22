import { createProfile, firstAvatarId } from "./api.ts";
import { expect, test } from "./fixtures.ts";
import { createAccount, PASSWORD, selectProfile } from "./member-support.ts";

/**
 * Parental controls hold in the app as on the server (docs/BACKEND.md §3, "Privileges"): a kids
 * profile neither manages profiles nor reaches account settings, and a profile added while
 * controls are in use asks for the account password. Each on a fresh account.
 */

test("a kids profile can switch profiles, and nothing else", async ({ page }) => {
  const request = page.context().request;
  await createAccount(request, { tag: "kids-guard" });
  await selectProfile(request, await createProfile(request, { name: "Pip", isKids: true }));

  await page.goto("/profiles");
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Sam/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage profiles" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Add profile" })).toHaveCount(0);

  await page.goto("/account");
  await expect(
    page.getByRole("heading", {
      name: "Account settings are available from a profile without parental controls",
    }),
  ).toBeVisible();
  await expect(page.getByText("Pip is a kids profile.", { exact: false })).toBeVisible();

  // The server agrees: from the kids profile, an 18+ profile cannot be added at all.
  const refused = await request.post("/api/v1/profiles", {
    headers: { "X-Webflix-Client": "web", "content-type": "application/json" },
    data: { name: "Free", avatarId: await firstAvatarId(request), maturityCeiling: "18+" },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe("unrestricted_profile_required");

  // Switching is still one click away.
  await page.getByRole("link", { name: "Switch profile" }).click();
  await page.getByRole("button", { name: /^Sam/ }).click();
  await expect(page).toHaveURL(/\/account/);
  await expect(
    page.getByRole("heading", {
      name: "Account settings are available from a profile without parental controls",
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage profiles" })).toBeVisible();
});

test("adding a profile while parental controls are in use asks for the password", async ({
  page,
}) => {
  const request = page.context().request;
  await createAccount(request, { tag: "add-guard" });
  await createProfile(request, { name: "Pip", isKids: true });

  await page.goto("/profiles/new");
  await page.getByRole("textbox", { name: "Name" }).fill("Guest");
  await page.getByRole("button", { name: "Add profile" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await confirm.getByLabel("Account password").fill("not-the-password-1");
  await confirm.getByRole("button", { name: "Add profile" }).click();
  await expect(confirm.getByLabel("Account password")).toHaveAccessibleDescription(/isn't right/);
  await confirm.getByLabel("Account password").fill(PASSWORD);
  await confirm.getByRole("button", { name: "Add profile" }).click();
  await expect(page).toHaveURL(/\/profiles(\/manage)?$/);
  const profiles = (await (await request.get("/api/v1/profiles")).json()) as {
    items: Array<{ name: string; maturityCeiling: string }>;
    parentalControls: boolean;
  };
  expect(profiles.parentalControls).toBe(true);
  expect(profiles.items.find((profile) => profile.name === "Guest")?.maturityCeiling).toBe("18+");
});

test("a locked profile asks for its PIN to change it, and its PIN or the password to delete it", async ({
  page,
}) => {
  const request = page.context().request;
  await createAccount(request, { tag: "locked-guard" });
  const pip = await createProfile(request, { name: "Pip" });
  // Lock Pip (a loosening change: it takes the account password).
  const lock = await request.patch(`/api/v1/profiles/${pip}`, {
    headers: { "X-Webflix-Client": "web", "content-type": "application/json" },
    data: { pin: "2580", currentPassword: PASSWORD },
  });
  expect(lock.status(), await lock.text()).toBe(200);
  const profiles = async () =>
    (
      (await (await request.get("/api/v1/profiles")).json()) as {
        items: Array<{ id: string; name: string }>;
      }
    ).items;

  // Changing it from Sam's session: said up front, then asked for at save.
  await page.goto(`/profiles/${pip}/edit`);
  await expect(page.getByText("Pip is locked. You'll be asked for Pip's PIN")).toBeVisible();
  await page.getByRole("textbox", { name: "Name" }).fill("Pip Two");
  await page.getByRole("button", { name: "Save" }).click();
  const unlock = page.getByRole("dialog", { name: "Profile lock is on" });
  await expect(
    unlock.getByText("Pip is locked. Enter Pip's PIN to save your changes."),
  ).toBeVisible();
  await unlock.getByLabel("Digit 1 of 4").pressSequentially("1111");
  await expect(unlock.getByRole("alert")).toContainText("Incorrect PIN");
  expect((await profiles()).map((profile) => profile.name)).toContain("Pip");
  await unlock.getByLabel("Digit 1 of 4").pressSequentially("2580");
  await expect(unlock).toBeHidden();
  await expect
    .poll(async () => (await profiles()).map((profile) => profile.name))
    .toContain("Pip Two");

  // Deleting it: confirm, then prove it, here with the account password instead of the PIN.
  await page.goto(`/profiles/${pip}/edit`);
  await page.getByRole("button", { name: "Delete profile" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete Pip Two?" })
    .getByRole("button", { name: "Delete profile" })
    .click();
  const proof = page.getByRole("dialog", { name: "Delete Pip Two?" });
  await expect(
    proof.getByText("Enter Pip Two's PIN to delete it.", { exact: false }),
  ).toBeVisible();
  await proof.getByRole("button", { name: "Use the account password instead" }).click();
  await proof.getByLabel("Account password").fill(PASSWORD);
  await proof.getByRole("button", { name: "Delete profile" }).click();
  await expect.poll(async () => (await profiles()).map((profile) => profile.name)).toEqual(["Sam"]);
});

test.describe("the shared demo account", () => {
  test.use({ demo: "Alex" });

  test("says what stays fixed, and offers no way to change it", async ({ page }) => {
    const session = (await (await page.request.get("/api/v1/session")).json()) as {
      account: { isDemo?: boolean };
      activeProfile: { id: string };
    };
    expect(session.account.isDemo).toBe(true);

    await page.goto("/account");
    const notice = page.getByText("This is the shared demo account", { exact: true });
    await expect(notice).toBeVisible();
    await expect(
      page.getByText("its sign-in details, membership and profiles can't be changed", {
        exact: false,
      }),
    ).toBeVisible();

    await page.goto("/profiles/manage");
    await expect(
      page.getByText(
        "This is the shared demo account: choose a profile to change its playback settings.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Add profile" })).toHaveCount(0);

    await page.goto("/profiles/new");
    await expect(page.getByText("Profiles can't be added to the demo account")).toBeVisible();

    await page.goto(`/profiles/${session.activeProfile.id}/edit`);
    await expect(page.getByText("This is the shared demo account", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Playback settings are yours to change", { exact: false }),
    ).toBeVisible();
  });
});
