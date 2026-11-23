import type { Plan, PlanId } from "@webflix/contracts";

/**
 * Plans are static configuration, not a table (blueprint §5). Prices are mock, in USD.
 *
 * `features` are shown as they are, on every plan card: quality on the one scale (HD, Full HD,
 * 4K) and the stream limit as "screens at a time", in the words of every other screen
 * (docs/DESIGN_SYSTEM.md "Plan wording"; a unit test holds them to `maxVideoHeight` and
 * `maxStreams`).
 */
export const PLAN_CATALOG: readonly Plan[] = [
  {
    id: "basic",
    name: "Basic",
    monthlyPrice: { amountMinor: 799, currency: "USD" },
    maxStreams: 1,
    maxQuality: "720p",
    maxVideoHeight: 720,
    features: ["HD video", "1 screen at a time", "Unlimited movies and series"],
    highlighted: false,
  },
  {
    id: "standard",
    name: "Standard",
    monthlyPrice: { amountMinor: 1299, currency: "USD" },
    maxStreams: 2,
    maxQuality: "1080p",
    maxVideoHeight: 1080,
    features: ["Full HD video", "2 screens at a time", "Unlimited movies and series"],
    highlighted: true,
  },
  {
    id: "premium",
    name: "Premium",
    monthlyPrice: { amountMinor: 1899, currency: "USD" },
    maxStreams: 4,
    maxQuality: "2160p",
    maxVideoHeight: 2160,
    features: ["4K video", "4 screens at a time", "Unlimited movies and series"],
    highlighted: false,
  },
];

export function getPlan(id: PlanId): Plan {
  const plan = PLAN_CATALOG.find((candidate) => candidate.id === id);
  // PlanId is a closed enum and every member is in the catalogue (checked by a unit test).
  if (!plan) throw new Error(`Unknown plan ${id}`);
  return plan;
}
