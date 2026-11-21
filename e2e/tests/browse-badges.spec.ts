import { CLIENT_HEADERS, createAccount, escapeRegExp } from "./api.ts";
import { row } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Badges are chosen by the server per surface (docs/RECOMMENDATIONS.md, Badges), against the
 * real API on a fresh account: a chart-topper the member is watching has no Top 10 badge in
 * Continue Watching, while its detail still says where it ranks, and the quality badge never
 * promises more than the title is packaged in or the plan allows.
 */

test.use({ viewport: { width: 1440, height: 900 } });

interface Card {
  id: string;
  name: string;
  top10Rank?: number;
  bestVideoQuality?: "sd" | "hd" | "full-hd" | "4k";
}

test("a chart-topper in Continue Watching: no Top 10 badge there, its rank on the detail", async ({
  page,
}) => {
  const request = page.context().request;
  await createAccount(request, { tag: "badges", plan: "standard" });
  const home = (await (await request.get("/api/v1/browse?view=home")).json()) as {
    rows: Array<{ layout: string; items: Array<{ rank?: number; title?: Card }> }>;
  };
  const leader = home.rows.find((candidate) => candidate.layout === "ranked")?.items[0]?.title;
  if (!leader) throw new Error("the home page has no Top 10 row");

  // Watch a couple of minutes of it; the release carries where the member stopped.
  const started = await request.post("/api/v1/playback/sessions", {
    headers: CLIENT_HEADERS,
    data: { titleId: leader.id },
  });
  expect(started.status(), await started.text()).toBe(201);
  const session = (await started.json()) as { id: string; durationSec: number };
  const released = await request.delete(`/api/v1/playback/sessions/${session.id}`, {
    headers: CLIENT_HEADERS,
    data: {
      positionSec: Math.min(120, Math.floor(session.durationSec * 0.5)),
      durationSec: session.durationSec,
      state: "paused",
    },
  });
  expect(released.status()).toBe(204);

  await page.goto("/browse");
  const continueRow = row(page, /^Continue Watching/);
  const tile = continueRow.getByRole("link", { name: new RegExp(escapeRegExp(leader.name)) });
  await expect(tile.first()).toBeVisible();
  await expect(tile.first()).not.toHaveAccessibleName(/Top 10/);

  await page.goto(`/browse?title=${leader.id}`);
  const dialog = page.getByRole("dialog", { name: leader.name });
  await expect(dialog.getByText("#1 on Webflix Today")).toBeVisible();
});

test("the quality badge is the lower of the title's best quality and the plan's cap", async ({
  page,
}) => {
  const request = page.context().request;
  await createAccount(request, { tag: "quality", plan: "basic" });
  const home = (await (await request.get("/api/v1/browse?view=home")).json()) as {
    rows: Array<{ items: Array<Card | { title: Card }> }>;
  };
  const cards = home.rows.flatMap((candidate) =>
    candidate.items.map((item) => ("title" in item ? item.title : item)),
  );
  const packaged = cards.find((card) => card.bestVideoQuality !== undefined);
  const external = cards.find((card) => card.bestVideoQuality === undefined);

  if (packaged) {
    // Basic streams at most 720p: never more than "HD", whatever the title is packaged in.
    const expected = packaged.bestVideoQuality === "sd" ? "SD" : "HD";
    await page.goto(`/browse?title=${packaged.id}`);
    const dialog = page.getByRole("dialog", { name: packaged.name });
    await expect(dialog.getByText(expected, { exact: true })).toBeVisible();
    await expect(dialog.getByText(/^(Full HD|4K)$/)).toHaveCount(0);
  }
  if (external) {
    // Unknown quality (external fallback media): no badge rather than a guess.
    await page.goto(`/browse?title=${external.id}`);
    const dialog = page.getByRole("dialog", { name: external.name });
    await expect(dialog.getByRole("heading", { name: "More Like This" })).toBeVisible();
    await expect(dialog.getByText(/^(SD|HD|Full HD|4K)$/)).toHaveCount(0);
  }
  expect(packaged ?? external, "no title on the home page to check").toBeTruthy();
});
