/**
 * Federated sign-in in the Worker under workerd: the identity area's end-to-end suite through the
 * Worker's own gateway (`handleFetch`: the development issuer at `/dev-idp/*`, then the app), on
 * D1 with the generated migrations, the D1 outbox as the mailbox, every fault of the development
 * issuer's catalogue included. Each test gets its own runtime (a copy of the bindings is a new
 * isolate-level runtime), so the relying party's caches and the issuer's standing faults start
 * empty; the D1 database is shared, so every test uses addresses of its own.
 */
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  describeFederatedSignIn,
  FEDERATION_FAULTS_COVERED,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
} from "@webflix/core/testing";
import { FAULT_NAMES } from "@webflix/dev-idp";
import { CookieJar, completeAuthorization } from "@webflix/dev-idp/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { developmentIssuerOf } from "../src/areas/identity.ts";
import { handleFetch } from "../src/index.ts";
import { getRuntime } from "../src/runtime.ts";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await getRuntime(env).services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: null,
    manifest: FIXTURE_MANIFEST,
  });
});

describe("the suite covers the development issuer's whole fault catalogue", () => {
  it("names every fault exactly once", () => {
    expect([...FEDERATION_FAULTS_COVERED].sort()).toEqual([...FAULT_NAMES].sort());
  });
});

interface Envelope {
  type: string;
  payload: unknown;
}

describeFederatedSignIn("Worker (workerd, D1)", async () => {
  // Jobs are captured and delivered on demand, to this runtime's processor.
  const queued: Envelope[] = [];
  const jobs = {
    async send(body: Envelope) {
      queued.push(body);
    },
    async sendBatch(messages: Array<{ body: Envelope }>) {
      for (const message of messages) queued.push(message.body);
    },
  } as unknown as Queue;
  const testEnv = {
    ...env,
    JOBS: jobs,
    WEBFLIX_EMAIL_SENDER: "outbox",
    WEBFLIX_OIDC_TIMEOUT_MS: "500",
    WEBFLIX_OIDC_JWKS_REFETCH_COOLDOWN_SEC: "0",
  } as typeof env;
  const runtime = getRuntime(testEnv);
  const fetch = (request: Request) => handleFetch(request, testEnv, createExecutionContext());
  return {
    origin: runtime.config.core.publicOrigin,
    fetch,
    authorize: (url, choice) => completeAuthorization(url, choice, { fetch, jar: new CookieJar() }),
    setStandingFaults(realm, faults) {
      const idp = developmentIssuerOf(testEnv)?.realms[realm];
      if (!idp) throw new Error(`no development issuer realm ${realm}`);
      idp.faults.clear();
      if (Object.keys(faults).length > 0) idp.faults.set(faults);
    },
    async drainJobs() {
      for (let message = queued.shift(); message; message = queued.shift()) {
        const outcome = await runtime.services.processor({
          id: crypto.randomUUID(),
          type: message.type,
          payload: message.payload as never,
          attempt: 1,
          enqueuedAt: Date.now(),
        });
        // The identity area's own jobs must succeed; another area's (a server event, say) are
        // that area's to prove, so their outcome does not decide this suite.
        if (outcome.action !== "ack" && message.type.startsWith("identity.")) {
          throw new Error(`job ${message.type} was not acknowledged`);
        }
      }
    },
    async seedDemo() {
      await runtime.services.seeder.seed({
        catalog: FIXTURE_CATALOG,
        demoAccount: FIXTURE_DEMO_ACCOUNT,
        manifest: FIXTURE_MANIFEST,
      });
    },
  };
});
