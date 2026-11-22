import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One recorded delivery (tools/stripe/fixtures/<scenario>/events.json, docs/STRIPE.md §19). */
export interface FixtureDelivery {
  n: number;
  received_offset_ms: number;
  delivery_of_id: number;
  event: StripeEvent;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> & { id?: string; object?: string } };
  request?: { idempotency_key?: string | null } | null;
}

export const FIXTURES_DIR = fileURLToPath(
  new URL("../../../../tools/stripe/fixtures/", import.meta.url),
);

export function scenarios(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function deliveries(scenario: string): FixtureDelivery[] {
  return JSON.parse(
    readFileSync(`${FIXTURES_DIR}${scenario}/events.json`, "utf8"),
  ) as FixtureDelivery[];
}

export function responses(scenario: string): { label: string; body: Record<string, unknown> }[] {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}${scenario}/responses.json`, "utf8")) as {
    label: string;
    body: Record<string, unknown>;
  }[];
}

/** Every distinct event of a scenario, first delivery only, in arrival order. */
export function events(scenario: string): StripeEvent[] {
  return deliveries(scenario)
    .filter((delivery) => delivery.delivery_of_id === 1)
    .map((delivery) => delivery.event);
}
