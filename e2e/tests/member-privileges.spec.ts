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
