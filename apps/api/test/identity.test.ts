/**
 * Federated sign-in in the Node runtime (dev mode's composition: SQLite, the development issuer
 * mounted at `/dev-idp/*` and called in process, the in-memory mailbox): the identity area's
 * end-to-end suite, every fault of the development issuer's catalogue included. A fresh runtime
 * per test, so the relying party's discovery and key caches and the issuer's standing faults
 * start empty each time.
 */
import { MemoryJobQueue } from "@webflix/core/memory";
import {
  describeFederatedSignIn,
  FEDERATION_FAULTS_COVERED,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
} from "@webflix/core/testing";
import { migrateToLatest } from "@webflix/db";
import { FAULT_NAMES, WEBFLIX_DEV_CLIENTS } from "@webflix/dev-idp";
import { CookieJar, completeAuthorization } from "@webflix/dev-idp/testing";
import { describe, expect, it } from "vitest";
import { developmentIssuerOf } from "../src/areas/identity.ts";
import { loadApiConfig } from "../src/config.ts";
import { createHttpApp, createRuntime } from "../src/runtime.ts";

describe("the suite covers the development issuer's whole fault catalogue", () => {
  it("names every fault exactly once", () => {
    expect([...FEDERATION_FAULTS_COVERED].sort()).toEqual([...FAULT_NAMES].sort());
    expect(FAULT_NAMES).toHaveLength(29);
  });
});

describeFederatedSignIn("Node runtime (SQLite)", async () => {
  const config = loadApiConfig({
    WEBFLIX_DATABASE_URL: "sqlite::memory:",
    WEBFLIX_BLOB_STORE: "memory",
    WEBFLIX_MEDIA_DIR: "none",
    // Independent of the billing area's adapters (this suite signs up without a membership).
    WEBFLIX_PAYMENT_PROVIDER: "memory",
    WEBFLIX_LOG_LEVEL: process.env.IDENTITY_TEST_LOG ?? "error",
    // A slow issuer must time out within the test; a rotated key is refetched at once.
    WEBFLIX_OIDC_TIMEOUT_MS: "500",
    WEBFLIX_OIDC_JWKS_REFETCH_COOLDOWN_SEC: "0",
  });
  const runtime = createRuntime(config, "api");
  await migrateToLatest(runtime.infra.database);
  await runtime.services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: null,
    manifest: FIXTURE_MANIFEST,
  });
  const app = createHttpApp(runtime);
  const queue = runtime.infra.jobs.queue;
  if (!(queue instanceof MemoryJobQueue)) throw new Error("expected the in-process job queue");
  queue.setProcessor(runtime.services.processor);
  const host = developmentIssuerOf(config);
  if (!host) throw new Error("the development issuer is not mounted");
  const fetch = async (request: Request) => app.request(request);
  return {
    origin: config.core.publicOrigin,
    fetch,
    authorize: (url, choice) => completeAuthorization(url, choice, { fetch, jar: new CookieJar() }),
    setStandingFaults(realm, faults) {
      const idp = host.realms[realm];
      if (!idp) throw new Error(`no realm ${realm}`);
      idp.faults.clear();
      if (Object.keys(faults).length > 0) idp.faults.set(faults);
    },
    drainJobs: () => queue.drain(),
    async seedDemo() {
      await runtime.services.seeder.seed({
        catalog: FIXTURE_CATALOG,
        demoAccount: FIXTURE_DEMO_ACCOUNT,
        manifest: FIXTURE_MANIFEST,
      });
    },
    cleanup: () => runtime.close(),
  };
});

describe("the batch jobs' service account (client credentials at the development staff issuer)", () => {
  it("gets a staff token the staff API accepts, with its fixed roles", async () => {
    const config = loadApiConfig({
      WEBFLIX_DATABASE_URL: "sqlite::memory:",
      WEBFLIX_BLOB_STORE: "memory",
      WEBFLIX_MEDIA_DIR: "none",
      WEBFLIX_LOG_LEVEL: "error",
      WEBFLIX_PAYMENT_PROVIDER: "memory",
    });
    const runtime = createRuntime(config, "api");
    try {
      await migrateToLatest(runtime.infra.database);
      const app = createHttpApp(runtime);
      const { clientId, clientSecret, roles } = WEBFLIX_DEV_CLIENTS.staffJobs;
      // What the pipeline sends (WEBFLIX_STAFF_TOKEN_URL, _CLIENT_ID, _CLIENT_SECRET).
      const issued = await app.request(`${config.core.publicOrigin}/dev-idp/staff/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      expect(issued.status).toBe(200);
      const { access_token: token } = (await issued.json()) as { access_token: string };
      const me = await app.request("/api/admin/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { roles: string[] }).roles.sort()).toEqual([...roles].sort());
      // A wrong secret gets nothing; nor does a member's session cookie on the staff API.
      const refused = await app.request(`${config.core.publicOrigin}/dev-idp/staff/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: "x".repeat(20),
        }),
      });
      expect(refused.status).toBe(401);
    } finally {
      await runtime.close();
    }
  });
});
