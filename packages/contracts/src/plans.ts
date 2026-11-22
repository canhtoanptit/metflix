import * as z from "zod";
import { PLAN_IDS, VIDEO_QUALITIES } from "./constants.ts";

export const PlanId = z.enum(PLAN_IDS).meta({ id: "PlanId" });
export type PlanId = z.output<typeof PlanId>;

export const VideoQuality = z.enum(VIDEO_QUALITIES);
export type VideoQuality = z.output<typeof VideoQuality>;

export const Money = z
  .object({
    amountMinor: z.number().int().nonnegative().meta({ description: "Amount in minor units." }),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .meta({ id: "Money" });
export type Money = z.output<typeof Money>;

/** An amount that may be negative (credits, proration lines), in minor units. */
export const SignedMoney = z
  .object({
    amountMinor: z
      .number()
      .int()
      .meta({ description: "Amount in minor units; negative is a credit." }),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .meta({ id: "SignedMoney" });
export type SignedMoney = z.output<typeof SignedMoney>;

export const PlanTrial = z.object({ days: z.number().int().positive() }).meta({ id: "PlanTrial" });
export type PlanTrial = z.output<typeof PlanTrial>;

/**
 * A membership plan. Plans are static configuration (blueprint §5), served by `GET /plans`;
 * the catalogue itself lives in `@webflix/core` (`PLAN_CATALOG`).
 */
export const Plan = z
  .object({
    id: PlanId,
    name: z.string(),
    monthlyPrice: Money,
    maxStreams: z.number().int().positive(),
    maxQuality: VideoQuality,
    /** Highest rendition height the player may select on this plan. */
    maxVideoHeight: z.number().int().positive(),
    features: z.array(z.string()),
    highlighted: z.boolean().meta({ description: "Shown as the recommended plan." }),
    /**
     * Milestone 2 (§5.4): the free trial a new member gets on this plan (one per account and
     * per card), or null. Absent until billing offers trials: the milestone 1 sign-up charges
     * at once, so no trial may be advertised before then.
     */
    trial: PlanTrial.nullable().optional(),
  })
  .meta({ id: "Plan" });
export type Plan = z.output<typeof Plan>;

export const PlanList = z.object({ items: z.array(Plan) }).meta({ id: "PlanList" });
export type PlanList = z.output<typeof PlanList>;
