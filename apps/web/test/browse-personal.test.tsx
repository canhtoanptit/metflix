import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { BrowsePage } from "@webflix/contracts";
import { makeBillboard, makeRow, resetFixtures } from "@webflix/contracts/fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "../src/app/query/keys.ts";
import { assignmentKey, useExperimentVariant } from "../src/app/session/experiments.ts";
import { browsePageQuery, rowPagesQuery } from "../src/features/browse/common/queries.ts";
import { placeRows } from "../src/features/browse/home/BrowsePage.tsx";

/**
 * The personalised home page's logic: how modules are numbered as the member sees them, how a
 * page is cached per experiment assignment, and where impressions say they happened.
 */

const observed: Array<{ element: Element; titleId: string; context: unknown }> = [];
const stopped: Element[] = [];

vi.mock("../src/app/telemetry/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/app/telemetry/runtime.ts")>()),
  observeImpression: (element: Element, card: { titleId: string; context?: unknown }) => {
    observed.push({ element, titleId: card.titleId, context: card.context });
    return () => stopped.push(element);
  },
  observeRowView: () => () => {},
  track: () => {},
}));

beforeEach(() => {
  resetFixtures();
  observed.length = 0;
  stopped.length = 0;
});

function page(overrides: Partial<BrowsePage>): BrowsePage {
  return { view: "home", billboard: null, rows: [], nextCursor: null, ...overrides };
}

describe("placeRows: modules numbered as the member sees them", () => {
  it("counts the billboard as module 1, then every row with something to show, across batches", () => {
    const first = page({
      billboard: makeBillboard(),
      rows: [
        makeRow("continue", { count: 3 }),
        makeRow("standard", { count: 0 }),
        makeRow("ranked"),
      ],
      policy: { id: "learned:20261122-000000-0eb0b5e1", explore: false },
    });
    const second = page({
      rows: [makeRow("standard"), makeRow("tall")],
      policy: { id: "rules", explore: false },
    });
    const placed = placeRows([first, second]);
    expect(placed.map((entry) => entry.placement.rowRank)).toEqual([2, 3, 4, 5]);
    // The empty row is not drawn, so it takes no number.
    expect(placed.map((entry) => entry.row.id)).not.toContain(first.rows[1]?.id);
    // Each row keeps the policy of the batch that brought it.
    expect(placed.map((entry) => entry.placement.policy?.id)).toEqual([
      "learned:20261122-000000-0eb0b5e1",
      "learned:20261122-000000-0eb0b5e1",
      "rules",
      "rules",
    ]);
    expect(placed[0]?.placement.rowId).toBe(first.rows[0]?.id);
  });

  it("starts at 1 on a view without a billboard, and says null when no policy was sent", () => {
    const placed = placeRows([page({ view: "new-popular", rows: [makeRow("standard")] })]);
    expect(placed[0]?.placement).toMatchObject({ rowRank: 1, policy: null });
    expect(placeRows(undefined)).toEqual([]);
  });
});

describe("pages cached per experiment assignment", () => {
  it("names a set of assignments stably, whatever their order", () => {
    expect(assignmentKey({})).toBe("");
    expect(assignmentKey({ "recs.learned-vs-rules": "treatment", "a.test": "control" })).toBe(
      "a.test=control,recs.learned-vs-rules=treatment",
    );
    expect(assignmentKey({ "a.test": "control", "recs.learned-vs-rules": "treatment" })).toBe(
      assignmentKey({ "recs.learned-vs-rules": "treatment", "a.test": "control" }),
    );
  });

  it("keeps a page fetched under one assignment from being shown under another", () => {
    const control = browsePageQuery("home", "recs.learned-vs-rules=control").queryKey;
    const treatment = browsePageQuery("home", "recs.learned-vs-rules=treatment").queryKey;
    expect(control).not.toEqual(treatment);
    // Still under the profile's browse prefix: profile switches and library patches reach it.
    expect(control.slice(0, 4)).toEqual([...qk.profile.browse("home")]);
    expect(rowPagesQuery("home:trending", "c1", "x=1").queryKey.slice(0, 4)).toEqual([
      ...qk.profile.row("home:trending"),
    ]);
    expect(rowPagesQuery("home:trending", "c1", "x=1").meta).toEqual({ silent: true });
  });

  it("lets a client-side experiment read its variant from the session (null: not in it)", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.session(), {
      authenticated: false,
      experiments: { "browse.row-artwork": "posters" },
    });
    function Probe() {
      const variant = useExperimentVariant("browse.row-artwork");
      const absent = useExperimentVariant("browse.other");
      return <p>{`${variant}|${absent}`}</p>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(screen.getByText("posters|null")).toBeInTheDocument();
  });
});

describe("impressions at the card's place", () => {
  it("observes a card once in its place, again only when its place changes", async () => {
    const { useCardImpression } = await import("../src/features/browse/common/telemetry.ts");
    const { TelemetryScope } = await import("../src/app/telemetry/index.ts");
    const policy = { id: "rules", explore: false };
    function Card({ rank }: { rank: number }) {
      const ref = useCardImpression({
        titleId: "t-one",
        placement: { rowId: "home:trending", rowRank: 3, rank, policy },
      });
      return (
        <a ref={ref} href="/x">
          card
        </a>
      );
    }
    const tree = (rank: number) => (
      <TelemetryScope context={{ surface: "home", policy }}>
        <Card rank={rank} />
      </TelemetryScope>
    );
    const view = render(tree(2));
    const element = view.container.querySelector("a") as Element;
    expect(observed).toHaveLength(1);
    expect(observed[0]?.context).toEqual({
      surface: "home",
      rowId: "home:trending",
      rowRank: 3,
      rank: 2,
      policy,
    });
    // Re-rendered in the same place: the same observation (the module counts appearances).
    view.rerender(tree(2));
    expect(observed).toHaveLength(1);
    // Moved to another place: observed there instead.
    view.rerender(tree(5));
    expect(stopped).toEqual([element]);
    expect(observed.at(-1)?.context).toMatchObject({ rank: 5 });
    view.unmount();
    expect(stopped).toHaveLength(2);
  });

  it("notes a title's open for the overlay, once, and only for that title, briefly", async () => {
    const { noteTitleOpen, takeTitleOpen } = await import(
      "../src/features/browse/common/telemetry.ts"
    );
    noteTitleOpen("t-a", { rowId: "home:trending", rowRank: 3, rank: 2 });
    expect(takeTitleOpen("t-b")).toBeNull();
    noteTitleOpen("t-a", { rowId: "home:trending", rowRank: 3, rank: 2 });
    expect(takeTitleOpen("t-a")).toMatchObject({ rowRank: 3, rank: 2 });
    expect(takeTitleOpen("t-a")).toBeNull();
    vi.useFakeTimers();
    noteTitleOpen("t-a", {});
    vi.advanceTimersByTime(5000);
    expect(takeTitleOpen("t-a")).toBeNull();
    vi.useRealTimers();
  });
});
