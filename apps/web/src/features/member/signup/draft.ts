import { PLAN_IDS, type PlanId } from "@webflix/contracts";

/**
 * The sign-up draft between steps. The account is only created at the payment step (the API
 * takes email, password, plan and card in one request), so earlier answers must survive
 * navigation, Back and a refresh:
 *
 * - email and plan live in sessionStorage (this tab only, gone when it closes);
 * - the password lives in memory only and is never persisted. After a refresh the payment step
 *   asks for it again instead of sending the member back to the start.
 *
 * Card details never enter the draft.
 */

const STORAGE_KEY = "webflix.signup.v1";

export interface SignupDraft {
  email: string | null;
  planId: PlanId | null;
}

const EMPTY: SignupDraft = { email: null, planId: null };

let password: string | null = null;

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

export function rememberPassword(value: string): void {
  password = value;
}

export function draftPassword(): string | null {
  return password;
}

/** After the account exists (or the member abandons the flow): forget everything. */
export function clearDraft(): void {
  password = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
