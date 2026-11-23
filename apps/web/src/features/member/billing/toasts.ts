import { toast } from "@webflix/ui";

/**
 * Membership toasts share one id (UX review 2.4): a later one replaces the earlier, so "ends on"
 * and "will continue" never stand side by side. Their words are the page's own (`endingNotice`,
 * `describeOutcome`), so a toast never says something the Membership page does not.
 */
export const MEMBERSHIP_TOAST_ID = "membership";

export function membershipToast(title: string, description?: string): void {
  toast.success(title, { id: MEMBERSHIP_TOAST_ID, ...(description ? { description } : {}) });
}
