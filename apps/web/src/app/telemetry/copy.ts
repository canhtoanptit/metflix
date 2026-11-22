/**
 * What Webflix says about behaviour data, in one place: the consent prompt and Account ›
 * Privacy say the same thing in the same words. Plain, specific, and only what is true of
 * what the service does (docs/BLUEPRINT-M2.md §6, docs/BACKEND.md §3).
 */
import type { ConsentPurpose } from "@webflix/contracts";

/** What is recorded with permission, and what is kept regardless. */
export const WHAT_IS_RECORDED =
  "Which titles you see, open and play, and how you search (never the words you type).";
export const WITHOUT_PERMISSION =
  "Without it, everything still works: recommendations then rely only on what you watch, rate and add to My List.";

export const PURPOSE_COPY: Record<ConsentPurpose, { label: string; description: string }> = {
  personalisation: {
    label: "Personalised recommendations",
    description: "What you browse and play helps choose the rows and titles we show you.",
  },
  analytics: {
    label: "Improving Webflix",
    description:
      "The same activity, counted together with everyone else's, shows us what works and what's broken.",
  },
};

/** Purposes in the order they are shown. */
export const PURPOSE_ORDER: readonly ConsentPurpose[] = ["personalisation", "analytics"];
