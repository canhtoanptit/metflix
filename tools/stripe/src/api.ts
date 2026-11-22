import type { Probe } from "./sandbox-logic.ts";

const API = "https://api.stripe.com";

/**
 * The version the CLI itself uses for the claim-status endpoint
 * (`sandboxClaimStatusVersion` in pkg/cmd/sandbox.go, CLI 1.55.14).
 */
const CLAIM_STATUS_VERSION = "2026-08-26.preview";

async function get(path: string, key: string, version?: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (version) headers["Stripe-Version"] = version;
  return fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
}

/**
 * Does the key still authenticate? A 401 means the sandbox is gone or expired; a 403 (missing
 * permission on a restricted key) still proves the key is live.
 */
export async function probeSandbox(
  secretKey: string,
): Promise<Probe & { claimDetails: Record<string, unknown> | null }> {
  let credentials: Probe["credentials"];
  try {
    const response = await get("/v1/customers?limit=1", secretKey);
    credentials = response.status === 401 ? "invalid" : "valid";
  } catch {
    return { credentials: "unreachable", claimed: null, claimDetails: null };
  }
  if (credentials === "invalid") return { credentials, claimed: null, claimDetails: null };

  let claimed: boolean | null = null;
  let claimDetails: Record<string, unknown> | null = null;
  try {
    const response = await get(
      "/v2/core/claimable_sandboxes/status",
      secretKey,
      CLAIM_STATUS_VERSION,
    );
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body.is_claimed === "boolean") claimed = body.is_claimed;
      claimDetails = body;
    }
  } catch {
    // The claim status is informational; a failure leaves it unknown.
  }
  return { credentials, claimed, claimDetails };
}
