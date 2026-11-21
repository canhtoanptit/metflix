import { type ApiClient, createApiClient } from "@webflix/contracts";

let client: ApiClient | null = null;

/**
 * The typed API client used by every query and mutation. Configured once at startup
 * (`main.tsx`): same-origin in production and dev (the Vite proxy forwards `/api`), or the
 * in-browser mock in mock mode. Tests install their own with `setApiClient`.
 */
export function api(): ApiClient {
  if (!client) throw new Error("The API client is not configured (call setApiClient first).");
  return client;
}

export function setApiClient(next: ApiClient): void {
  client = next;
}

/** Production client: same origin, cookies included, zod-free (small bundle). */
export function createDefaultApiClient(): ApiClient {
  return createApiClient();
}
