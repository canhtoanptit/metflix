/**
 * @webflix/dev-idp/testing: the relying-party test kit. Portable (Node and workerd); for an
 * issuer on a real port use `@webflix/dev-idp/node`.
 */

export type { DevIdpFaults, FaultName } from "../faults.ts";
export { FAULT_CATALOGUE, FAULT_NAMES } from "../faults.ts";
export {
  type AuthorizationOutcome,
  CookieJar,
  completeAuthorization,
  type DriveOptions,
  type FetchLike,
  type SignInChoice,
} from "./browser.ts";
export {
  createAppleClientSecret,
  createPkce,
  ManualClock,
  type SignInRequest,
  type SignInResult,
  startTestIssuer,
  TEST_CLIENT_SECRETS,
  TEST_CLIENTS,
  TEST_POST_LOGOUT_URI,
  TEST_REDIRECT_URI,
  type TestIssuer,
  type TestIssuerOptions,
  testClientAuthentication,
  testClients,
} from "./issuer.ts";
