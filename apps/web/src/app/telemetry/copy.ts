/**
 * What Webflix says about behaviour data, in one place: the consent prompt and Account ›
 * Privacy say the same thing in the same words. Plain, specific, and only what is true of
 * what the service does (docs/BLUEPRINT-M2.md §6, docs/BACKEND.md §3).
 */
import type { ConsentPurpose } from "@webflix/contracts";

/** What is recorded with permission. */
export const WHAT_IS_RECORDED =
  "Which titles you see, open and play, and how you search (never the words you type).";
/**
 * What changes without permission for personalised recommendations: the server then builds the
 * rows with its rule engine (privacy review L1), from the member's own history, ratings and list,
 * and from what is new and popular.
 */
export const WITHOUT_PERSONALISATION =
  "Without personalised recommendations, everything still works: your rows then come from what you watch and rate, your My List, and what's new and popular on Webflix.";
/**
 * What Webflix keeps whatever the answer: what it needs to work. A refusal is itself recorded
 * (the answer, so it can be honoured), and so is watch history (Continue Watching).
 */
export const KEPT_REGARDLESS =
  "Whatever you choose, Webflix keeps what it needs to work, like your watch history, ratings and My List.";
/** The same, said after a refusal (the choice is made: "whatever you choose" would read oddly). */
export const KEPT_AFTER_REFUSAL =
  "Webflix still keeps what it needs to work, like your watch history, ratings and My List.";

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
