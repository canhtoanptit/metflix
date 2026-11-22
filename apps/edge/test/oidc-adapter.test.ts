/**
 * The generic OpenID relying party at the adapter level, against the development issuer's test
 * kit in process: the `IdentityProvider` contract per issuer profile, and every fault of the
 * catalogue refused by its own rule (core's `describeOidcRelyingParty`).
 */
import { describeOidcRelyingParty, type KitIssuer } from "@webflix/core/testing";
import { DEVELOPMENT_APPLE_CLIENT_KEY } from "@webflix/dev-idp";
import {
  CookieJar,
  startTestIssuer,
  TEST_CLIENT_SECRETS,
  TEST_REDIRECT_URI,
} from "@webflix/dev-idp/testing";

function issuer(profile: "google" | "apple"): KitIssuer {
  const t = startTestIssuer({ profile });
  return {
    issuer: t.issuer,
    fetch: (request) => t.fetch(request),
    clock: t.clock,
    authorize: async (url, choice) => {
      const outcome = await t.completeAuthorization(url, choice as never, new CookieJar());
      return { code: outcome.code, state: outcome.state, iss: outcome.iss, error: outcome.error };
    },
    setFaults(faults) {
      t.idp.faults.clear();
      if (Object.keys(faults).length > 0) t.idp.faults.set(faults);
    },
  };
}

describeOidcRelyingParty("workerd", () => ({
  google: () => issuer("google"),
  apple: () => issuer("apple"),
  redirectUri: TEST_REDIRECT_URI,
  clients: {
    basic: {
      clientId: "confidential-basic",
      secret: TEST_CLIENT_SECRETS["confidential-basic"] ?? "",
    },
    es256: { clientId: "es256-client", secret: TEST_CLIENT_SECRETS["es256-client"] ?? "" },
    apple: {
      clientId: "apple-style",
      teamId: "DEVTEAM001",
      keyId: "DEVKEY0001",
      privateKey: DEVELOPMENT_APPLE_CLIENT_KEY,
    },
  },
}));
