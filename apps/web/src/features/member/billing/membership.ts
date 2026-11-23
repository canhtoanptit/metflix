import type { Checkout, SessionState } from "@webflix/contracts";
import type { BadgeTone } from "@webflix/ui";
import { type MembershipView, membershipOf } from "../../../app/session/session.ts";
import { formatLongDate } from "../shared/format.ts";
import { membershipOutcome } from "./outcome.ts";

/**
 * Where a signed-in account stands in sign-up (docs/BLUEPRINT-M2.md §5.1): the account exists
 * from the first step, the membership only once the provider has confirmed a payment (or a
 * trial), and profiles come last.
 *
 * - `account`: signed out, sign-up starts at the beginning;
 * - `plan`: no membership yet (`none`);
 * - `payment`: a first payment awaits confirmation (`incomplete`);
 * - `profiles`: a membership (or a past one) and nobody to watch as yet;
 * - `complete`: set up. A membership that ended or is on hold is not sign-up any more: Account
 *   and the paywall offer the way back.
 */
export type SignupStage = "account" | "plan" | "payment" | "profiles" | "complete";

export function signupStage(session: SessionState): SignupStage {
  if (!session.authenticated) return "account";
  const { membership } = membershipOf(session);
  if (membership.status === "none") return "plan";
  if (membership.status === "incomplete") return "payment";
  return session.profiles.length === 0 ? "profiles" : "complete";
}

/**
 * An account that has not finished sign-up (no profile yet), signed in at the gate. The server
 * treats it as the account holder (UX review 1.1): Account, Security, Devices, Privacy and
 * Membership open for it, and finishing sign-up is offered there, never forced. Once one profile
 * exists, account management happens from a profile again.
 */
export function isUnfinishedSignup(session: SessionState): boolean {
  return session.authenticated && session.activeProfile === null && session.profiles.length === 0;
}

/**
 * The page a member who stopped half-way resumes at, on any device: a checkout in progress (the
 * server's, `GET /billing/checkout`) takes them back to its payment step with its plan (and the
 * promo code it carries); otherwise the server's membership decides.
 */
export async function resumeHref(
  session: SessionState,
  openCheckout: () => Promise<Checkout | null>,
): Promise<string> {
  const stage = signupStage(session);
  if (!session.authenticated || stage === "account") return "/signup";
  const { membership } = membershipOf(session);
  switch (stage) {
    case "plan":
    case "payment": {
      const open = await openCheckout().catch(() => null);
      const plan = open?.planId ?? membership.planId;
      return plan ? `/signup/payment?plan=${plan}` : "/signup/plan";
    }
    case "profiles":
      return "/signup/profile";
    case "complete":
      return session.activeProfile ? "/browse" : "/profiles";
  }
}

/**
 * A membership set to end (cancelled, not yet over): when, and what that means, in the words the
 * Membership page, its toasts and the profile gate all use. Null when it is not ending.
 */
export function endingNotice(view: MembershipView): { title: string; body: string } | null {
  const outcome = membershipOutcome(view);
  if (outcome.noChargeBecause !== "cancelled") return null;
  const ends = outcome.watchingEnds;
  const trial = ends?.because === "trial_ends";
  return {
    title: ends
      ? `Your ${trial ? "free trial" : "membership"} ends on ${formatLongDate(ends.at)}`
      : "Your membership is ending",
    body: "You can watch until then, and nothing more is charged.",
  };
}

export type MembershipAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "resume"; label: string };

export interface MembershipStanding {
  /** Short status label for a badge. */
  badge: { label: string; tone: BadgeTone };
  /** A notice worth showing, or null when all is well. */
  notice: {
    tone: "danger" | "info" | "accent";
    title: string;
    body: string;
    action: MembershipAction | null;
  } | null;
}

/**
 * The membership in plain words, for Account, the profile gate and the paywall. One place, so
 * every screen says the same thing about the same state.
 */
export function describeStanding({ membership, entitlement }: MembershipView): MembershipStanding {
  const until = (iso: string | null) => (iso ? formatLongDate(iso) : null);
  switch (membership.status) {
    case "none":
      return {
        badge: { label: "No membership", tone: "outline" },
        notice: {
          tone: "accent",
          title: "Finish setting up your membership",
          body: "Choose a plan and add a payment method to start watching.",
          action: { kind: "link", label: "Choose a plan", href: "/signup/plan" },
        },
      };
    case "incomplete":
      return {
        badge: { label: "Payment pending", tone: "neutral" },
        notice: {
          tone: "accent",
          title: "Your first payment isn't confirmed yet",
          body: "Your membership starts as soon as your payment is confirmed.",
          action: {
            kind: "link",
            label: "Finish payment",
            href: membership.planId ? `/signup/payment?plan=${membership.planId}` : "/signup/plan",
          },
        },
      };
    case "trialing":
    case "active": {
      const ending = endingNotice({ membership, entitlement });
      const trial = membership.status === "trialing";
      return {
        badge: trial
          ? { label: "Free trial", tone: "positive" }
          : ending
            ? { label: "Ending", tone: "neutral" }
            : { label: "Active", tone: "positive" },
        notice: ending
          ? {
              tone: "info",
              title: ending.title,
              body: `${ending.body} Changed your mind? ${
                trial
                  ? "Keep your membership and it continues after the trial."
                  : "Keep it in one click."
              }`,
              action: { kind: "resume", label: "Keep my membership" },
            }
          : null,
      };
    }
    case "past_due": {
      const grace = until(membership.graceEndsAt ?? entitlement.until);
      return {
        badge: { label: "Payment failed", tone: "danger" },
        notice: {
          tone: "danger",
          title: "We couldn't take your last payment",
          body: grace
            ? `You can keep watching until ${grace}. Update your payment method before then so your membership continues.`
            : "Update your payment method so your membership continues.",
          action: {
            kind: "link",
            label: "Update payment method",
            href: "/account/membership/payment",
          },
        },
      };
    }
    case "suspended":
      return {
        badge: { label: "On hold", tone: "danger" },
        notice: {
          tone: "danger",
          title: "Your membership is on hold",
          body:
            membership.suspendedReason === "paused"
              ? "Your membership is paused, so watching is off for now. Update your payment method to restart it."
              : "We couldn't take payment, so watching is paused. Update your payment method and we'll charge what's due to restart your membership.",
          action: {
            kind: "link",
            label: "Update payment method",
            href: "/account/membership/payment",
          },
        },
      };
    case "canceled":
      return {
        badge: { label: "Ended", tone: "outline" },
        notice: {
          tone: "accent",
          title: "Your membership has ended",
          body: "Restart anytime. Your profiles, My List and viewing activity are still here.",
          action: { kind: "link", label: "Restart membership", href: "/account/plan" },
        },
      };
  }
}
