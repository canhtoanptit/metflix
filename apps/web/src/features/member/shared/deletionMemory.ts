/**
 * This browser asked for its account to be deleted (Account › Privacy): it remembers when the
 * deletion was due, and nothing else (no address, no account ID). Once that day has passed the
 * account and its sessions are gone, so the member lands on Sign in, and signing in fails as a
 * typo would. The server cannot say more without revealing which addresses have accounts; the
 * browser that asked can say what it asked for. Any other browser knows nothing of it.
 *
 * Kept in local storage for 30 days after the date; forgotten when the member keeps the account,
 * when the account's list no longer holds the deletion, and when someone signs in on this
 * browser after the date (that is another account: the deleted one cannot sign in).
 */

const KEY = "webflix:deletion-due";
const KEPT_AFTER_DUE_MS = 30 * 24 * 3600_000;

export function rememberDeletion(scheduledFor: string): void {
  if (Number.isNaN(Date.parse(scheduledFor))) return;
  try {
    localStorage.setItem(KEY, scheduledFor);
  } catch {
    // Without storage, Sign in simply says what it says to anyone.
  }
}

export function forgetDeletion(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}

/** When the deletion this browser asked for was due, once that has passed; otherwise null. */
export function deletedAsAsked(now = Date.now()): string | null {
  try {
    const due = localStorage.getItem(KEY);
    if (!due) return null;
    const at = Date.parse(due);
    if (Number.isNaN(at) || now - at > KEPT_AFTER_DUE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return at <= now ? due : null;
  } catch {
    return null;
  }
}

/** Someone signed in on this browser: past the date, that is another account, so forget it. */
export function forgetDeletionOnSignIn(now = Date.now()): void {
  if (deletedAsAsked(now)) forgetDeletion();
}
