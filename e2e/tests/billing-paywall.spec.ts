import { addProfile, aMovie, createBareAccount, requireFakeProvider } from "./billing-support.ts";
import { expect, test } from "./fixtures.ts";
import { expectAccessible } from "./member-support.ts";

/**
 * Playback refused for the membership (`subscription_required` with the membership's status) is
 * a way to finish or restore it, never an error; a profile with parental controls is told who
 * can (docs/BLUEPRINT-M2.md §5.2).
 */

test.beforeEach(async ({ page }) => {
  await requireFakeProvider(page.context().request);
});

test("an account without a membership that tries to watch is offered the way to finish", async ({
  page,
}) => {
  const request = page.context().request;
  await createBareAccount(request, "billing-paywall");
  await addProfile(request);
  const movie = await aMovie(request);
  await page.goto(`/watch/${movie.id}`);
  await expect(page.getByTestId("watch-status-membership")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Finish setting up your membership" }),
  ).toBeFocused();
  await expect(page.getByText(`to watch ${movie.name}`)).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Choose a plan" }).click();
  await expect(page).toHaveURL(/\/signup\/plan/);
  await expect(page.getByRole("heading", { name: /Choose the plan/ })).toBeVisible();
});

test("a kids profile meets the paywall with a way to switch, not account forms", async ({
  page,
}) => {
  const request = page.context().request;
  await createBareAccount(request, "billing-paywall-kids");
  const kidsId = await addProfile(request, "Pip");
  const patched = await request.patch(`/api/v1/profiles/${kidsId}`, {
    headers: { "X-Webflix-Client": "web" },
    data: { isKids: true, maturityCeiling: "7+" },
  });
  expect(patched.status(), await patched.text()).toBe(200);
  const movie = (await aMovie(request).catch(() => null)) ?? null;
  test.skip(!movie, "no movie a kids profile may watch on this target");
  await page.goto(`/watch/${movie?.id}`);
  await expect(page.getByTestId("watch-status-membership")).toBeVisible();
  await expect(page.getByText(/ask the account holder, or switch profile/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Switch profile" })).toBeVisible();
});
