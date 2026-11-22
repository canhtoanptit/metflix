import type { MembershipStatus } from "@webflix/contracts";

/**
 * Playback refused with `subscription_required` (docs/BLUEPRINT-M2.md §5.2): a clear way to
 * finish or restore the membership, chosen by the status the server named, never an error.
 * Profiles with parental controls cannot manage the account, so they are told who can.
 */
export interface Paywall {
  title: string;
  body: string;
  /** The one action that resolves it (for the account holder). */
  action: { label: string; href: string };
}

export function describePaywall(
  status: MembershipStatus | undefined,
  options: { titleName: string; planId: string | null },
): Paywall {
  const name = options.titleName;
  switch (status) {
    case "none":
      return {
        title: "Finish setting up your membership",
        body: `Choose a plan and add a payment method to watch ${name}.`,
        action: { label: "Choose a plan", href: "/signup" },
      };
    case "incomplete":
      return {
        title: "Your first payment isn't confirmed yet",
        body: `Your membership starts as soon as the payment is confirmed. Finish it to watch ${name}.`,
        action: {
          label: "Finish payment",
          href: options.planId
            ? `/account/membership/checkout?plan=${options.planId}`
            : "/account/membership/plan",
        },
      };
    case "suspended":
      return {
        title: "Your membership is on hold",
        body: `We couldn't take payment, so watching is paused. Update your payment method and we'll charge what's due, then you can watch ${name}.`,
        action: { label: "Update payment method", href: "/account/membership/payment" },
      };
    case "canceled":
      return {
        title: "Your membership has ended",
        body: `Restart your membership to watch ${name}. Your profiles, My List and progress are all saved.`,
        action: { label: "Restart membership", href: "/account/membership/plan" },
      };
    default:
      return {
        title: "Your membership doesn't include watching right now",
        body: `Check your membership to watch ${name}.`,
        action: { label: "Go to Membership", href: "/account/membership" },
      };
  }
}
