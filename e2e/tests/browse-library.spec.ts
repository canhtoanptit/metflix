import type { Page } from "@playwright/test";
import { apiResponse, createAccount, escapeRegExp } from "./api.ts";
import { waitForAnimations } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

/**
 * My List, ratings and profile settings change data: each spec works on its own fresh account,
 * so they run in parallel with everything else and nothing needs putting back.
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function firstTitleNotInMyList(page: Page) {
  const response = await page.request.get("/api/v1/browse/genre/drama?limit=50");
  const genre = (await response.json()) as {
    items: Array<{
      id: string;
      name: string;
      viewer: { inMyList: boolean; rating: string | null };
    }>;
  };
  const title = genre.items.find((item) => !item.viewer.inMyList && !item.viewer.rating);
  if (!title) throw new Error("every drama is already listed");
  return title;
}

test("My List: add from the details, find it on My List, remove it there with Undo", async ({
  page,
}) => {
  await createAccount(page.context().request, { tag: "mylist" });
  const title = await firstTitleNotInMyList(page);
  await page.goto(`/browse?title=${title.id}`);
  const dialog = page.getByRole("dialog", { name: title.name });
  const added = apiResponse(page, "PUT", /\/api\/v1\/my-list\//);
  await dialog.getByRole("button", { name: `Add ${title.name} to My List` }).click();
  expect((await added).ok()).toBe(true);
  await expect(
    dialog.getByRole("button", { name: `Remove ${title.name} from My List` }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "My List" })
    .click();
  const grid = page.getByRole("list", { name: "My List" });
  const named = new RegExp(`^${escapeRegExp(title.name)}`);
  const card = grid.getByRole("link", { name: named });
  await expect(card).toBeVisible();
  // Most recently added first.
  await expect(grid.getByRole("link").first()).toHaveAccessibleName(named);

  // Remove from the card's preview: the card leaves the grid at once, with Undo.
  await card.hover();
  const preview = page.getByTestId("hover-preview");
  await expect(preview).toBeVisible();
  await waitForAnimations(page);
  const remove = preview.getByRole("button", { name: `Remove ${title.name} from My List` });
  await expect(remove).toBeInViewport({ ratio: 1 });
  await remove.click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(card).toBeVisible();

  // And from the details; then the server agrees once the removal has answered.
  await card.click();
  const removed = apiResponse(page, "DELETE", /\/api\/v1\/my-list\//);
  await page
    .getByRole("dialog", { name: title.name })
    .getByRole("button", { name: `Remove ${title.name} from My List` })
    .click();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  expect((await removed).ok()).toBe(true);
  const check = await page.request.get(`/api/v1/titles/${title.id}`);
  expect(((await check.json()) as { viewer: { inMyList: boolean } }).viewer.inMyList).toBe(false);
});

test("ratings: love a title, see it after a reload, then clear it", async ({ page }) => {
  await createAccount(page.context().request, { tag: "ratings" });
  const title = await firstTitleNotInMyList(page);
  await page.goto(`/browse?title=${title.id}`);
  const dialog = page.getByRole("dialog", { name: title.name });
  const rate = dialog.getByRole("button", { name: `Rate ${title.name}` });
  await rate.focus();
  await page.keyboard.press("Enter");
  const rated = apiResponse(page, "PUT", /\/api\/v1\/ratings\//);
  await dialog.getByRole("button", { name: "Love this!", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /^Rated Love this!/ })).toBeVisible();
  // Reload only once the rating has reached the server (a reload would cancel it in flight).
  expect((await rated).ok()).toBe(true);

  await page.reload();
  const again = page.getByRole("dialog", { name: title.name });
  const loved = again.getByRole("button", { name: /^Rated Love this!/ });
  await expect(loved).toBeVisible();
  await loved.focus();
  await page.keyboard.press("Enter");
  await again.getByRole("button", { name: "Love this!", exact: true }).click();
  await expect(again.getByRole("button", { name: `Rate ${title.name}` })).toBeVisible();
});

test("a profile with previews turned off never loads a preview clip", async ({ page }) => {
  const request = page.context().request;
  await createAccount(request, {
    tag: "previews-off",
    profile: { settings: { autoplayPreviews: false } },
  });
  // Only meaningful when the billboard has a clip it would otherwise play.
  const home = (await (await request.get("/api/v1/browse?view=home")).json()) as {
    billboard: { title: { preview: unknown } } | null;
  };
  test.skip(
    !home.billboard?.title.preview,
    "the billboard title has no preview clip on this target",
  );
  const clips: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/cdn/previews/")) clips.push(request.url());
  });
  await page.goto("/browse");
  await expect(page.getByRole("region", { name: /^Featured: / })).toBeVisible();
  await page.waitForTimeout(3500);
  expect(clips).toEqual([]);
});
