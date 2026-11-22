import type { APIRequestContext, Page } from "@playwright/test";
import {
  type CatalogCard,
  CLIENT_HEADERS,
  catalogCards,
  createAccount,
  sendPatiently,
} from "./api.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Fictional titles play cuts of freely licensed films. The first second of what they play must
 * never be the source film's own title card ("TEARS OF STEEL" once opened the series Lagrange).
 *
 * A pixel heuristic, calibrated on the packaged media: the densest horizontal band of bright,
 * sharply edged pixels. Real opening frames scored at most 0.023; the same frames with a title
 * drawn on, 0.15 (bold) and 0.047 or more (small and dim). Over `LIMIT` fails. Two controls keep
 * the detector honest: a title drawn onto a real frame, and a real film's own opening title card
 * (Big Buck Bunny, which plays under its own name) must both score over it. Every run attaches a
 * contact sheet of the frames for a person to look at.
 *
 * The sample: Lagrange's first episode (the regression), a title playing a Cosmos Laundromat cut,
 * then other fictional titles with distinct source cuts, up to `SAMPLE`.
 */
const LIMIT = 0.05;
const SAMPLE = 10;
const REGRESSION = "Lagrange";
const CONTROL = "Big Buck Bunny";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

interface Pick {
  id: string;
  name: string;
  asset: string;
  /** Series: its first episode. */
  episodeId: string | null;
}

/** The asset a title plays (its play target), from a probe playback session. */
async function assetOf(request: APIRequestContext, card: CatalogCard): Promise<string | null> {
  const start = await sendPatiently("start a probe playback session", () =>
    request.post("/api/v1/playback/sessions", {
      headers: CLIENT_HEADERS,
      data: { titleId: card.id },
    }),
  );
  if (start.status() !== 201) return null;
  const session = (await start.json()) as { id: string; manifestUrl: string };
  await request.delete(`/api/v1/playback/sessions/${session.id}`, {
    headers: { "X-Webflix-Client": "web" },
  });
  return /\/vod\/([^/]+)\//.exec(session.manifestUrl)?.[1] ?? null;
}

/** A film plays under its own name when its asset is named after the title. */
const ownFilm = (card: CatalogCard, asset: string) =>
  asset.replace(/^v-/, "").startsWith(card.id.replace(/^t-/, ""));

async function firstEpisode(request: APIRequestContext, card: CatalogCard) {
  if (card.type !== "series") return null;
  const episodes = (await (
    await request.get(`/api/v1/titles/${card.id}/seasons/1/episodes`)
  ).json()) as { items: Array<{ id: string }> };
  return episodes.items[0]?.id ?? null;
}

async function sample(request: APIRequestContext): Promise<Pick[]> {
  const cards = new Map<string, CatalogCard>();
  for (const view of ["home", "series", "movies"] as const) {
    for (const card of await catalogCards(request, view)) cards.set(card.id, card);
  }
  const ordered = [...cards.values()].sort(
    (a, b) => Number(b.name === REGRESSION) - Number(a.name === REGRESSION),
  );
  const picks: Pick[] = [];
  const cuts = new Set<string>();
  let cosmos = false;
  for (const card of ordered) {
    if (picks.length >= SAMPLE && cosmos) break;
    const asset = await assetOf(request, card);
    if (!asset || ownFilm(card, asset)) continue;
    const isCosmos = asset.includes("cosmos-laundromat");
    const wanted =
      card.name === REGRESSION ||
      (isCosmos && !cosmos) ||
      (picks.length < SAMPLE && !cuts.has(asset));
    if (!wanted) continue;
    picks.push({
      id: card.id,
      name: card.name,
      asset,
      episodeId: await firstEpisode(request, card),
    });
    cuts.add(asset);
    cosmos ||= isCosmos;
  }
  return picks;
}

/** The densest band of bright, sharply edged pixels in a 320×180 frame (0-1). */
const TEXT_SCORE = `(ctx, w, h) => {
  const { data } = ctx.getImageData(0, 0, w, h);
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) luma[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  const band = Math.round(h * 0.12);
  let best = 0;
  for (let y0 = 0; y0 + band <= h; y0 += Math.round(band / 3)) {
    let hits = 0;
    for (let y = y0 + 1; y < y0 + band - 1; y++) for (let x = 1; x < w - 1; x++) {
      const gx = Math.abs(luma[y * w + x + 1] - luma[y * w + x - 1]);
      const gy = Math.abs(luma[(y + 1) * w + x] - luma[(y - 1) * w + x]);
      if ((gx > 70 || gy > 70) && luma[y * w + x] > 150) hits++;
    }
    best = Math.max(best, hits / (w * band));
  }
  return best;
}`;

interface Frame {
  at: number;
  score: number;
  jpeg: string;
}

/** Frames at about 0.3 s, 0.6 s and 0.95 s of the watch page's video, scored. */
async function firstSecond(page: Page, pick: Pick): Promise<Frame[]> {
  const episode = pick.episodeId ? `&episode=${pick.episodeId}` : "";
  await page.goto(`/watch/${pick.id}?t=0${episode}`);
  return page.evaluate(async (source) => {
    const score = new Function(`return ${source}`)() as (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
    ) => number;
    const video = await new Promise<HTMLVideoElement>((resolve) => {
      const look = () => {
        const found = document.querySelector("video");
        if (found) resolve(found);
        else setTimeout(look, 50);
      };
      look();
    });
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no 2d canvas");
    const frames: Frame[] = [];
    const deadline = performance.now() + 40_000;
    for (const target of [0.3, 0.6, 0.95]) {
      while (video.currentTime < target && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      context.drawImage(video, 0, 0, 320, 180);
      frames.push({
        at: video.currentTime,
        score: score(context, 320, 180),
        jpeg: canvas.toDataURL("image/jpeg", 0.7),
      });
    }
    return frames;
  }, TEXT_SCORE);
}

/** A real frame with a title drawn on, scored: the detector must see it. */
async function drawnTitleScore(page: Page, jpeg: string): Promise<number> {
  return page.evaluate(
    async ({ source, jpeg }) => {
      const score = new Function(`return ${source}`)() as (
        ctx: CanvasRenderingContext2D,
        w: number,
        h: number,
      ) => number;
      const image = new Image();
      image.src = jpeg;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("no 2d canvas");
      context.drawImage(image, 0, 0, 320, 180);
      context.fillStyle = "#f2e6c8";
      context.font = "bold 30px Georgia";
      context.textAlign = "center";
      context.fillText("TEARS OF STEEL", 160, 99);
      return score(context, 320, 180);
    },
    { source: TEXT_SCORE, jpeg },
  );
}

test("fictional titles never open on a source film's title card", async ({ page }) => {
  test.slow();
  const request = page.context().request;
  await createAccount(request, { plan: "premium", tag: "firstsec" });
  const picks = await sample(request);
  test.skip(picks.length === 0, "this target has no title that plays another film's cut");
  expect(
    picks.some((pick) => pick.name === REGRESSION),
    `the sample includes ${REGRESSION}`,
  ).toBe(true);
  expect(
    picks.some((pick) => pick.asset.includes("cosmos-laundromat")),
    "the sample includes a Cosmos Laundromat cut",
  ).toBe(true);

  // Only the picture: the player's own title and controls would read as text.
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "body * { visibility: hidden !important } video { visibility: visible !important }";
    document.addEventListener("DOMContentLoaded", () => document.head.append(style));
  });

  const rows: Array<Pick & { frames: Frame[]; control?: boolean }> = [];
  for (const pick of picks) rows.push({ ...pick, frames: await firstSecond(page, pick) });

  // Controls: a drawn title, and a real film's own opening title card.
  const drawn = await drawnTitleScore(page, rows[0]?.frames[0]?.jpeg ?? "");
  const control = (await request
    .get(`/api/v1/search?q=${encodeURIComponent(CONTROL)}`)
    .then((response) => response.json())) as {
    results: Array<{ title?: CatalogCard } & Partial<CatalogCard>>;
  };
  const controlCard = control.results
    .map((result) => (result.title ?? result) as CatalogCard)
    .find((card) => card.name === CONTROL);
  const controlAsset = controlCard ? await assetOf(request, controlCard) : null;
  if (controlCard && controlAsset && ownFilm(controlCard, controlAsset)) {
    const pick = {
      id: controlCard.id,
      name: controlCard.name,
      asset: controlAsset,
      episodeId: null,
    };
    rows.push({ ...pick, frames: await firstSecond(page, pick), control: true });
  }

  const sheet =
    `<!doctype html><meta charset=utf-8><title>First second of fictional titles</title><body style="background:#111;color:#eee;font:14px system-ui">` +
    rows
      .map(
        (row) =>
          `<div style="display:flex;gap:8px;align-items:center;margin:6px"><div style="width:240px">${row.control ? "CONTROL (real film, own title card): " : ""}${row.name}<br><small>${row.id} · ${row.asset}</small></div>${row.frames
            .map(
              (frame) =>
                `<figure style="margin:0"><img src="${frame.jpeg}" width=320><figcaption>${frame.at.toFixed(2)} s · score ${frame.score.toFixed(3)}</figcaption></figure>`,
            )
            .join("")}</div>`,
      )
      .join("") +
    "</body>";
  await test.info().attach("first-second.html", { body: sheet, contentType: "text/html" });

  expect(drawn, "the detector flags a title drawn onto a real frame").toBeGreaterThan(LIMIT * 2);
  const controlRow = rows.find((row) => row.control);
  if (controlRow) {
    expect(
      Math.max(...controlRow.frames.map((frame) => frame.score)),
      `the detector flags ${CONTROL}'s own opening title card`,
    ).toBeGreaterThan(LIMIT);
  } else {
    test.info().annotations.push({ type: "control", description: `${CONTROL} not found` });
  }
  for (const row of rows.filter((candidate) => !candidate.control)) {
    for (const frame of row.frames) {
      expect(
        frame.score,
        `${row.name} (${row.asset}) at ${frame.at.toFixed(2)} s looks like a title card`,
      ).toBeLessThan(LIMIT);
    }
  }
});
