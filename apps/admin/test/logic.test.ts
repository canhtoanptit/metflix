/** Pure logic: attempts and keys, experiment phases, amounts, form validation against the contract. */
import {
  adminRoutes,
  CollectionBody,
  CreateExperimentBody,
  type ExperimentDefinition,
  STAFF_ROLES,
} from "@webflix/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { AREAS, canCall, hasRole, ROUTE_ROLES } from "../src/access/roles.ts";
import {
  closeAttempt,
  openAttempt,
  peekAttempt,
  renewAttempt,
  resetAttempts,
  updateAttempt,
} from "../src/components/attempts.ts";
import { reasonError } from "../src/components/ReasonField.tsx";
import { parseRuntimeConfig } from "../src/config/runtime.ts";
import { validateCollection } from "../src/features/content/CollectionEditorPage.tsx";
import { buildDesign, NEW_EXPERIMENT } from "../src/features/experiments/ExperimentFormPage.tsx";
import { experimentPhase } from "../src/features/experiments/phase.ts";
import { readResults } from "../src/features/operations/PrivacyJobsPage.tsx";
import { importOutcomeText } from "../src/features/operations/RecommendationsPage.tsx";
import { parseMajorAmount } from "../src/lib/format.ts";

beforeEach(() => resetAttempts());

describe("attempts", () => {
  it("keeps one idempotency key per intention, through every send, until a new intention", () => {
    const first = openAttempt("refund:a:i");
    expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    updateAttempt("refund:a:i", { phase: "sending" });
    updateAttempt("refund:a:i", { phase: "unresolved" });
    expect(openAttempt("refund:a:i").idempotencyKey).toBe(first.idempotencyKey);
    const renewed = renewAttempt("refund:a:i");
    expect(renewed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(renewed.phase).toBe("editing");
    closeAttempt("refund:a:i");
    expect(peekAttempt("refund:a:i")).toBeUndefined();
  });
});

const base: ExperimentDefinition = {
  ...(buildDesign({ ...NEW_EXPERIMENT, key: "home.test", name: "Test" }).design as Omit<
    ExperimentDefinition,
    | "status"
    | "statusChangeAt"
    | "previousStatus"
    | "salt"
    | "registeredAt"
    | "createdAt"
    | "updatedAt"
  >),
  status: "draft",
  statusChangeAt: null,
  previousStatus: null,
  salt: "abc",
  registeredAt: null,
  createdAt: "2026-11-23T10:00:00.000Z",
  updatedAt: "2026-11-23T10:00:00.000Z",
};
const NOW = Date.parse("2026-11-23T10:00:00.000Z");

describe("experimentPhase", () => {
  it("says a start is scheduled, with its instant, until it takes effect, then live", () => {
    const started: ExperimentDefinition = {
      ...base,
      status: "running",
      previousStatus: "draft",
      statusChangeAt: "2026-11-23T10:01:00.000Z",
      startsAt: "2026-11-23T10:01:00.000Z",
    };
    expect(experimentPhase(started, NOW)).toMatchObject({
      label: "Starting",
      changeLabel: "Starts at",
      changesAt: "2026-11-23T10:01:00.000Z",
      effective: "draft",
    });
    expect(experimentPhase(started, NOW + 61_000)).toMatchObject({
      label: "Live",
      effective: "running",
    });
  });

  it("is live at once where the change is immediate (dev), paused while paused, over past its end", () => {
    expect(experimentPhase({ ...base, status: "running", startsAt: null }, NOW).label).toBe("Live");
    expect(experimentPhase({ ...base, status: "paused" }, NOW).label).toBe("Paused");
    expect(
      experimentPhase({ ...base, status: "running", endsAt: "2026-11-23T09:00:00.000Z" }, NOW)
        .label,
    ).toBe("Window over");
    expect(
      experimentPhase({ ...base, status: "running", startsAt: "2026-11-24T00:00:00.000Z" }, NOW),
    ).toMatchObject({ label: "Scheduled", changeLabel: "Starts at" });
  });
});

describe("amounts", () => {
  it("parses major units with at most the currency's decimals", () => {
    expect(parseMajorAmount("12.5", "USD")).toBe(1250);
    expect(parseMajorAmount("12,50", "EUR")).toBe(1250);
    expect(parseMajorAmount("0.01", "USD")).toBe(1);
    expect(parseMajorAmount("1.234", "USD")).toBeNull();
    expect(parseMajorAmount("-3", "USD")).toBeNull();
    expect(parseMajorAmount("abc", "USD")).toBeNull();
    expect(parseMajorAmount("500", "JPY")).toBe(500);
    expect(parseMajorAmount("5.5", "JPY")).toBeNull();
  });
});

describe("validation agrees with the contract", () => {
  it("the reason", () => {
    expect(reasonError("ok")).not.toBeNull();
    expect(reasonError("   ok   ")).not.toBeNull();
    expect(reasonError("why")).toBeNull();
    expect(reasonError("x".repeat(501))).not.toBeNull();
  });

  it("an experiment the form accepts, the contract accepts", () => {
    const { design, errors } = buildDesign({
      ...NEW_EXPERIMENT,
      key: "home.autoplay",
      name: "Autoplay",
    });
    expect(errors).toEqual({});
    expect(CreateExperimentBody.safeParse({ ...design, reason: "test" }).success).toBe(true);
    expect(design.layer).toBe("home-autoplay");
    expect(design.allocation).toEqual({ start: 0, end: 10_000 });
  });

  it("an experiment the form refuses names the field", () => {
    const { errors } = buildDesign({
      ...NEW_EXPERIMENT,
      key: "Bad Key",
      name: "",
      allocStart: "60",
      allocEnd: "40",
      countries: "GB, United Kingdom",
      variants: [
        { name: "a", weight: "1" },
        { name: "a", weight: "1" },
      ],
      alpha: "0.9",
    });
    expect(Object.keys(errors).sort()).toEqual(
      ["allocEnd", "alpha", "countries", "key", "layer", "name", "variants"].sort(),
    );
  });

  it("a collection", () => {
    const draft = {
      name: "Picks",
      description: "",
      view: "home" as const,
      position: "3",
      titleIds: ["t-sintel"],
      status: "draft" as const,
    };
    expect(validateCollection(draft)).toEqual({});
    expect(
      CollectionBody.safeParse({ ...draft, description: null, position: 3, reason: "test" })
        .success,
    ).toBe(true);
    expect(
      Object.keys(validateCollection({ ...draft, name: " ", position: "51", titleIds: [] })).sort(),
    ).toEqual(["name", "position", "titleIds"]);
  });

  it("an export-events results document", () => {
    expect(readResults("not json").error).toMatch(/isn't JSON/);
    expect(readResults(JSON.stringify({ format: "other" })).error).toMatch(
      /isn't an export-events/,
    );
    const ok = readResults(
      JSON.stringify({
        format: "webflix.export-events-results",
        formatVersion: 1,
        generatedAt: "2026-11-22T09:20:00.000Z",
        results: [
          {
            requestId: "r1",
            status: "deferred",
            from: "2026-01-01T00:00:00.000Z",
            to: "2026-02-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(ok.error).toBeNull();
    expect(ok.document?.results).toHaveLength(1);
  });
});

describe("roles mirror the staff API's guard", () => {
  it("the console's role table equals the contract's, route by route", () => {
    for (const name of Object.keys(adminRoutes) as (keyof typeof adminRoutes)[]) {
      expect(ROUTE_ROLES[name], name).toBe(adminRoutes[name].staffRole);
    }
    expect(Object.keys(ROUTE_ROLES).sort()).toEqual(Object.keys(adminRoutes).sort());
  });

  it("admin opens everything; every other role exactly its own", () => {
    for (const role of STAFF_ROLES) expect(hasRole(["admin"], role)).toBe(true);
    expect(hasRole(["support"], "billing")).toBe(false);
    for (const name of Object.keys(adminRoutes) as (keyof typeof adminRoutes)[]) {
      const required = adminRoutes[name].staffRole;
      expect(canCall(["admin"], name)).toBe(true);
      if (required !== "any" && required !== "admin") {
        expect(canCall([required], name)).toBe(true);
        const other = STAFF_ROLES.find((role) => role !== required && role !== "admin");
        if (other) expect(canCall([other], name)).toBe(false);
      }
    }
    expect(AREAS.map((area) => area.role)).toEqual([
      "support",
      "billing",
      "content",
      "experiments",
      "admin",
    ]);
  });
});

describe("recommendation import answers", () => {
  it("says what each outcome means, and that only a queued import changes anything", () => {
    const status = { activeModel: null, lastImport: null };
    expect(importOutcomeText({ ...status, outcome: "queued", run: "r9", detail: null })).toMatch(
      /r9 is being imported/,
    );
    for (const outcome of [
      "nothing_published",
      "already_served",
      "invalid",
      "no_artefact_store",
    ] as const) {
      expect(importOutcomeText({ ...status, outcome, run: "r9", detail: "bad checksum" })).toMatch(
        /Nothing changed/,
      );
    }
    expect(
      importOutcomeText({ ...status, outcome: "invalid", run: "r9", detail: "bad checksum" }),
    ).toContain("bad checksum");
    // The served run published again with other content (an erasure): applied in place.
    const served = {
      activeModel: {
        run: "r9",
        asOf: "2026-11-22T00:00:00.000Z",
        expiresAt: "2026-11-25T00:00:00.000Z",
        importedAt: "2026-11-22T04:10:00.000Z",
      },
      lastImport: null,
    };
    expect(importOutcomeText({ ...served, outcome: "queued", run: "r9", detail: null })).toMatch(
      /published again with corrected content/,
    );
  });
});

describe("runtime config", () => {
  it("resolves a path issuer on this origin, derives the registered redirects, refuses plain http elsewhere", () => {
    const config = parseRuntimeConfig(
      { issuer: "/dev-idp/staff/", clientId: "webflix-admin" },
      "http://localhost:5890",
      "/admin/",
    );
    expect(config).toMatchObject({
      issuer: "http://localhost:5890/dev-idp/staff",
      redirectUri: "http://localhost:5890/admin/auth/callback",
      postLogoutRedirectUri: "http://localhost:5890/admin/",
      development: true,
    });
    const keycloak = parseRuntimeConfig(
      { issuer: "https://sso.example/realms/webflix", clientId: "webflix-admin" },
      "https://webflix.example",
      "/admin/",
    );
    expect(keycloak.development).toBe(false);
    expect(() =>
      parseRuntimeConfig(
        { issuer: "http://sso.example/realms/webflix", clientId: "webflix-admin" },
        "https://webflix.example",
        "/admin/",
      ),
    ).toThrow(/https/);
    expect(() =>
      parseRuntimeConfig({ issuer: "/dev-idp/staff" }, "http://localhost", "/admin/"),
    ).toThrow(/client id/);
  });
});
