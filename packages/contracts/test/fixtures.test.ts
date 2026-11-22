import { beforeEach, describe, expect, it } from "vitest";
import {
  makeAuthenticatedSession,
  makeBrowsePage,
  makePlaybackSession,
  makeRow,
  makeTitleCard,
  makeTitleDetail,
  resetFixtures,
} from "../src/fixtures/index.ts";
import {
  AuthenticatedSession,
  BrowsePage,
  ChangePlanBody,
  createProblem,
  EmailAddress,
  PlaybackSession,
  Problem,
  Row,
  SignupBody,
  TitleDetail,
} from "../src/index.ts";

describe("fixtures", () => {
  beforeEach(() => resetFixtures());

  it("are deterministic after reset", () => {
    const first = makeTitleCard();
    resetFixtures();
    expect(makeTitleCard()).toEqual(first);
  });

  it("produce contract-valid values", () => {
    expect(BrowsePage.safeParse(makeBrowsePage()).success).toBe(true);
    expect(TitleDetail.safeParse(makeTitleDetail({ type: "series" })).success).toBe(true);
    expect(PlaybackSession.safeParse(makePlaybackSession()).success).toBe(true);
    expect(AuthenticatedSession.safeParse(makeAuthenticatedSession()).success).toBe(true);
  });

  it("build rows of every layout with the right item shapes", () => {
    const ranked = makeRow("ranked");
    expect(ranked.items.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const continuing = makeRow("continue", { count: 2 });
    expect(continuing.items[0]?.progress.positionSec).toBeGreaterThan(0);
    const tall = makeRow("tall", { overrides: { title: "Only on Webflix", nextCursor: "c1" } });
    expect(Row.parse(tall).nextCursor).toBe("c1");
  });

  it("apply overrides and still validate them", () => {
    expect(makeTitleCard({ name: "Sintel" }).name).toBe("Sintel");
    expect(() => makeTitleCard({ matchScore: 101 })).toThrow();
  });
});

describe("problems", () => {
  it("createProblem output parses as Problem", () => {
    const problem = createProblem("rate_limited", { retryAfterSec: 30, detail: "Slow down" });
    expect(Problem.parse(problem)).toEqual({
      type: "urn:webflix:problem:rate_limited",
      title: "Too many requests",
      status: 429,
      code: "rate_limited",
      detail: "Slow down",
      retryAfterSec: 30,
    });
  });

  it("rejects problems missing required extension members", () => {
    const problem = { ...createProblem("not_found"), code: "stream_limit_reached", status: 409 };
    expect(Problem.safeParse(problem).success).toBe(false);
  });
});

describe("input normalisation", () => {
  it("trims and lowercases emails", () => {
    expect(EmailAddress.parse("  Demo@Webflix.DEV ")).toBe("demo@webflix.dev");
    expect(EmailAddress.safeParse("not-an-email").success).toBe(false);
  });

  it("refuses card data in the sign-up and plan-change bodies (principle 4)", () => {
    const card = {
      method: "card",
      cardNumber: "4242 4242 4242 4242",
      expMonth: 12,
      expYear: 2030,
      cvc: "123",
      nameOnCard: "Mara",
    };
    const signup = { email: "mara@example.com", password: "correct horse battery" };
    expect(SignupBody.safeParse(signup).success).toBe(true);
    const withCard = SignupBody.safeParse({ ...signup, planId: "basic", payment: card });
    expect(withCard.success).toBe(false);
    // The refusal names the keys, never their values.
    expect(JSON.stringify(withCard.error?.issues)).not.toContain("4242");
    expect(ChangePlanBody.safeParse({ planId: "premium" }).success).toBe(true);
    expect(ChangePlanBody.safeParse({ planId: "premium", payment: card }).success).toBe(false);
  });
});
