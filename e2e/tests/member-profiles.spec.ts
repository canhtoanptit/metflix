import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { CLIENT_HEADERS, createAccount, expectAccessible, PASSWORD } from "./member-support.ts";

/** "Who's watching?" and profile management against the real API, each on a fresh account. */

async function profiles(page: Page) {
  return (await (await page.context().request.get("/api/v1/profiles")).json()).items as Array<{
    id: string;
    name: string;
    isKids: boolean;
    maturityCeiling: string;
    isLocked: boolean;
    avatar: { id: string };
    settings: { autoplayNextEpisode: boolean; subtitleLanguage: string | null };
  }>;
}

test("add, edit, lock, unlock and delete a profile", async ({ page }) => {
  await createAccount(page.context().request, { tag: "profiles" });
  await page.goto("/profiles");
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
  await expectAccessible(page);

  // Add a kids profile with a chosen picture.
  await page.getByRole("link", { name: "Add profile" }).click();
  await expect(page).toHaveURL(/\/profiles\/new/);
  await page.getByRole("button", { name: "Add profile" }).click();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveAccessibleDescription(
    "Enter a name.",
  );
  await page.getByRole("textbox", { name: "Name" }).fill("Pip");
  await page.getByRole("switch", { name: "Kids profile" }).click();
  await expect(page.getByRole("radio", { name: /16\+/ })).toBeDisabled();
  await page.getByRole("button", { name: "Change profile picture" }).click();
  const picker = page.getByRole("dialog", { name: "Choose a profile picture" });
  await expect(picker.getByRole("radio").first()).toBeVisible();
  await expectAccessible(page);
  await picker.getByRole("radio").nth(3).click();
  await picker.getByRole("button", { name: "Use this picture" }).click();
  await expect(picker).toBeHidden();
  await page.getByRole("button", { name: "Add profile" }).click();
  await expect(page).toHaveURL(/\/profiles$/);
  await expect(page.getByRole("button", { name: /^Pip/ })).toBeVisible();
  const pip = (await profiles(page)).find((profile) => profile.name === "Pip");
  expect(pip).toMatchObject({ isKids: true, maturityCeiling: "7+" });

  // Edit: a name clash is caught, turning kids off and raising the rating asks for the password.
  await page.goto("/profiles/manage");
  await page.getByRole("link", { name: "Edit Pip" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("sam");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveAccessibleDescription(
    /Another profile already has this name/,
  );
  await page.getByRole("textbox", { name: "Name" }).fill("Pip Junior");
  await page.getByRole("switch", { name: "Kids profile" }).click();
  await page.getByRole("radio", { name: /13\+ · Teens/ }).click();
  await page.getByRole("button", { name: "Save" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await confirm.getByLabel("Account password").fill("wrong-password-1");
  await confirm.getByRole("button", { name: "Save changes" }).click();
  await expect(confirm.getByLabel("Account password")).toHaveAccessibleDescription(/isn't right/);
  await expectAccessible(page);
  await confirm.getByLabel("Account password").fill(PASSWORD);
  await confirm.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/profiles\/manage/);
  expect((await profiles(page)).find((profile) => profile.id === pip?.id)).toMatchObject({
    name: "Pip Junior",
    isKids: false,
    maturityCeiling: "13+",
  });

  // Lock with a PIN (PIN, then password), then the gate asks for it.
  await page.getByRole("link", { name: "Edit Pip Junior" }).click();
  await page.getByRole("button", { name: "Add a PIN" }).click();
  const lock = page.getByRole("dialog", { name: "Lock this profile" });
  await lock.getByLabel("Digit 1 of 4").pressSequentially("2580");
  await lock.getByLabel("Account password").fill(PASSWORD);
  await lock.getByRole("button", { name: "Save PIN" }).click();
  await expect(page.getByText("Locked with a PIN")).toBeVisible();
  await page.goto("/profiles");
  await page.getByRole("button", { name: /^Pip Junior/ }).click();
  const pin = page.getByRole("dialog", { name: "Profile lock is on" });
  await pin.getByLabel("Digit 1 of 4").pressSequentially("1111");
  await expect(pin.getByRole("alert")).toContainText("Incorrect PIN");
  await expect(pin.getByLabel("Digit 1 of 4")).toBeFocused();
  await expectAccessible(page);
  await page.keyboard.type("2580");
  await expect(page).toHaveURL(/\/browse/);

  // Remove the lock, then delete the profile (while it is the active one).
  await page.goto(`/profiles/${pip?.id}/edit`);
  await page.getByRole("button", { name: "Remove lock" }).click();
  const unlock = page.getByRole("dialog", { name: "Remove profile lock" });
  await unlock.getByLabel("Account password").fill(PASSWORD);
  await unlock.getByRole("button", { name: "Remove lock" }).click();
  await expect(page.getByText("Not locked")).toBeVisible();
  await page.getByRole("button", { name: "Delete profile" }).click();
  const remove = page.getByRole("alertdialog", { name: "Delete Pip Junior?" });
  await expect(remove).toContainText("You're using this profile now");
  await remove.getByRole("button", { name: "Delete profile" }).click();
  await expect(page).toHaveURL(/\/profiles\/manage/);
  expect((await profiles(page)).map((profile) => profile.name)).toEqual(["Sam"]);
});

test("five profiles is the limit; the last profile cannot be deleted", async ({ page }) => {
  await createAccount(page.context().request, { tag: "limit5" });
  const avatars = await (await page.context().request.get("/api/v1/avatars")).json();
  for (const name of ["Ana", "Ben", "Cal", "Dee"]) {
    const response = await page.context().request.post("/api/v1/profiles", {
      headers: CLIENT_HEADERS,
      data: { name, avatarId: avatars.groups[1].avatars[0].id },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/profiles");
  await expect(page.getByRole("button", { name: /^Dee/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add profile" })).toHaveCount(0);
  await page.goto("/profiles/new");
  await expect(page.getByText("This account already has five profiles")).toBeVisible();

  // Down to one: its delete button explains why it is disabled.
  for (const profile of (await profiles(page)).slice(1)) {
    await page
      .context()
      .request.delete(`/api/v1/profiles/${profile.id}`, { headers: CLIENT_HEADERS });
  }
  const [last] = await profiles(page);
  await page.goto(`/profiles/${last?.id}/edit`);
  await expect(page.getByRole("button", { name: "Delete profile" })).toBeDisabled();
  await expect(page.getByText(/only profile on the account/)).toBeVisible();
});

test("playback settings are saved per profile", async ({ page }) => {
  const account = await createAccount(page.context().request, { tag: "settings" });
  await page.goto(`/profiles/${account.profileId}/edit`);
  await page.getByRole("switch", { name: "Autoplay next episode" }).click();
  await page.getByRole("combobox", { name: "Subtitles" }).click();
  await page.getByRole("option", { name: "Spanish" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).not.toHaveURL(/\/edit$/);
  const [profile] = await profiles(page);
  expect(profile?.settings).toMatchObject({ autoplayNextEpisode: false, subtitleLanguage: "es" });
});
