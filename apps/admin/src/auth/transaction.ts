/**
 * The one thing the console keeps outside memory: an unfinished sign-in, for the single round
 * trip to the issuer and back (the page is unloaded in between). It holds the PKCE verifier, the
 * nonce and where to return; never a token. It lives in `sessionStorage` (this tab only, gone
 * when the tab closes), keyed by its `state`, removed the moment the callback reads it, and
 * dropped after ten minutes. A verifier is worthless once its code is redeemed (single use), and
 * worthless without the code the issuer sends to this tab.
 */

const PREFIX = "webflix-admin:signin:";
const SIGNED_OUT = "webflix-admin:signed-out";
const MAX_AGE_MS = 10 * 60 * 1000;

export interface SignInTransaction {
  state: string;
  verifier: string;
  nonce: string;
  /** A path under the console's base, to come back to after signing in. */
  returnTo: string;
  /** Asked with `prompt=none` (a reload): a refusal shows the sign-in page, never loops. */
  silent: boolean;
  createdAt: number;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** False when this browser refuses session storage (sign-in cannot work then). */
export function transactionStorageAvailable(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(`${PREFIX}probe`, "1");
    store.removeItem(`${PREFIX}probe`);
    return true;
  } catch {
    return false;
  }
}

export function saveTransaction(transaction: SignInTransaction): void {
  const store = storage();
  if (!store) throw new Error("Session storage is unavailable");
  purgeTransactions(transaction.createdAt);
  store.setItem(`${PREFIX}${transaction.state}`, JSON.stringify(transaction));
}

/** Read and remove the transaction a callback's `state` names (null: unknown or expired). */
export function takeTransaction(state: string, now = Date.now()): SignInTransaction | null {
  const store = storage();
  if (!store || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
  const key = `${PREFIX}${state}`;
  const raw = store.getItem(key);
  store.removeItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SignInTransaction;
    if (parsed.state !== state || now - parsed.createdAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Drop unfinished sign-ins older than ten minutes (an abandoned issuer page). */
export function purgeTransactions(now = Date.now()): void {
  const store = storage();
  if (!store) return;
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const key = store.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const parsed = JSON.parse(store.getItem(key) ?? "") as Partial<SignInTransaction>;
      if (typeof parsed.createdAt !== "number" || now - parsed.createdAt > MAX_AGE_MS) {
        store.removeItem(key);
      }
    } catch {
      store.removeItem(key);
    }
  }
}

/**
 * Remember, across the issuer's sign-out redirect, that the staff member signed out on purpose:
 * the page that loads next shows "Signed out" instead of signing straight back in.
 */
export function markSignedOut(now = Date.now()): void {
  try {
    storage()?.setItem(SIGNED_OUT, String(now));
  } catch {
    // Without the mark the next load tries a silent sign-in, which the ended session refuses.
  }
}

export function takeSignedOutMark(now = Date.now()): boolean {
  const store = storage();
  if (!store) return false;
  const raw = store.getItem(SIGNED_OUT);
  store.removeItem(SIGNED_OUT);
  return raw !== null && now - Number(raw) < MAX_AGE_MS;
}
