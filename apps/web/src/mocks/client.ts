import { type ApiClient, createRouteClient, routes } from "@webflix/contracts";
import { createMockServer, type MockServerOptions } from "./server.ts";

/**
 * Typed API client backed by the in-browser mock. Responses are validated against the contract
 * schemas, so a mock that drifts from the contract fails loudly.
 */
export function createMockApiClient(options: MockServerOptions = {}): ApiClient {
  const server = createMockServer(options);
  return createRouteClient(routes, { fetch: server.fetch, validateResponses: true });
}
