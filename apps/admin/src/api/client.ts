/**
 * The staff API client: `createAdminApiClient` (typed by `adminRoutes`), with the session's
 * bearer token on every call, no cookie (`credentials: "omit"`: the member session on this
 * origin never travels with a staff call), and one renewal on `401` before giving up.
 */
import { type AdminApiClient, createAdminApiClient, type FetchLike } from "@webflix/contracts";
import type { StaffSession } from "../auth/session.ts";

let client: AdminApiClient | null = null;

export function staffApi(): AdminApiClient {
  if (!client) throw new Error("The staff API client is not configured");
  return client;
}

export function setStaffApi(next: AdminApiClient): void {
  client = next;
}

export function createStaffApi(
  session: Pick<StaffSession, "accessToken" | "renewAfterRefusal" | "expire">,
  baseFetch: FetchLike = (input, init) => globalThis.fetch(input, init),
): AdminApiClient {
  const fetchWithRenewal: FetchLike = async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status !== 401) return response;
    // The guard refused before any handler ran, so sending the same request again (same body,
    // same idempotency key) after renewing cannot act twice.
    if (!(await session.renewAfterRefusal())) return response;
    await response.body?.cancel();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await session.accessToken()}`);
    const retried = await baseFetch(input, { ...init, headers });
    if (retried.status === 401) session.expire();
    return retried;
  };
  return createAdminApiClient({
    accessToken: () => session.accessToken(),
    fetch: fetchWithRenewal,
    credentials: "omit",
  });
}
