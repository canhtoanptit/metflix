import { QueryClient } from "@tanstack/react-query";
import { ApiError, createProblem } from "@webflix/contracts";
import { makeBrowsePage, makeTitleDetail, resetFixtures } from "@webflix/contracts/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { describeError, isRetryableError } from "../src/app/query/errors.ts";
import { qk } from "../src/app/query/keys.ts";
import { optimisticUpdate, patchTitleViewer } from "../src/app/query/optimistic.ts";

beforeEach(() => resetFixtures());

describe("patchTitleViewer", () => {
  it("patches every occurrence of a title across row layouts and keeps other branches identical", () => {
    const page = makeBrowsePage();
    const ranked = page.rows.find((row) => row.layout === "ranked");
    const standard = page.rows.find((row) => row.layout === "standard");
    if (ranked?.layout !== "ranked" || standard?.layout !== "standard") throw new Error("fixture");
    const target = ranked.items[0]?.title.id ?? "";
    const next = patchTitleViewer(page, target, { inMyList: true });
    const nextRanked = next.rows.find((row) => row.layout === "ranked");
    if (nextRanked?.layout !== "ranked") throw new Error("fixture");
    expect(nextRanked.items[0]?.title.viewer.inMyList).toBe(true);
    expect(next.rows.find((row) => row.layout === "standard")).toBe(standard);
    expect(patchTitleViewer(page, "t-missing", { inMyList: true })).toBe(page);
  });
});

describe("optimisticUpdate", () => {
  it("applies to every query under the prefix and rolls back exactly", async () => {
    const client = new QueryClient();
    const detail = makeTitleDetail();
    client.setQueryData(qk.profile.title(detail.id), detail);
    client.setQueryData(qk.session(), { authenticated: false });
    const rollback = await optimisticUpdate(client, qk.profile.all(), (data) =>
      patchTitleViewer(data, detail.id, { inMyList: true }),
    );
    expect(client.getQueryData<typeof detail>(qk.profile.title(detail.id))?.viewer.inMyList).toBe(
      true,
    );
    rollback();
    expect(client.getQueryData(qk.profile.title(detail.id))).toEqual(detail);
  });
});

describe("error descriptions", () => {
  it("speaks plainly and only retries what can succeed", () => {
    const offline = new ApiError({
      type: "urn:webflix:problem:network_error",
      title: "Network error",
      status: 0,
      code: "network_error",
    });
    expect(describeError(offline).title).toBe("Can't reach Webflix");
    expect(isRetryableError(offline)).toBe(true);
    const limited = new ApiError(
      createProblem("rate_limited", { retryAfterSec: 12, requestId: "req-1" }),
    );
    expect(describeError(limited)).toMatchObject({
      description: "Please wait 12 seconds and try again.",
      reference: "req-1",
    });
    expect(isRetryableError(new ApiError(createProblem("not_found")))).toBe(false);
  });
});
