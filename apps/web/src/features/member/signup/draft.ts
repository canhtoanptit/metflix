import { PLAN_IDS, type PlanId } from "@webflix/contracts";

/**
 * What sign-up remembers in this tab (sessionStorage, gone when it closes): the email typed on
 * the landing page (prefilled at step 1) and the plan last chosen, so Back, a refresh and the
 * plan picked on the landing page all come back selected. The account itself exists from step 1
 * (docs/BLUEPRINT-M2.md §5.1), so the password is never kept, and card details never pass
 * through Webflix at all.
 */

const STORAGE_KEY = "webflix.signup.v2";

export interface SignupDraft {
  email: string | null;
  planId: PlanId | null;
}

const EMPTY: SignupDraft = { email: null, planId: null };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readDraft(): SignupDraft {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      email: typeof value.email === "string" && value.email.length > 0 ? value.email : null,
      planId:
        typeof value.planId === "string" && (PLAN_IDS as readonly string[]).includes(value.planId)
          ? (value.planId as PlanId)
          : null,
    };
  } catch {
    return EMPTY;
  }
}

export function updateDraft(patch: Partial<SignupDraft>): SignupDraft {
  const next = { ...readDraft(), ...patch };
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or full storage: the flow still works within this page view.
  }
  return next;
}

/** Once sign-up is finished (or abandoned): forget it. */
export function clearDraft(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
