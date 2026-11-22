/**
 * What this browser remembers about a trip to the payment provider's page, per account, in
 * localStorage: which checkout (or card change) was handed to the provider's form, so that coming
 * back without a result (the Back button, a closed tab) is noticed and asked about once. The
 * checkout itself is the server's (`GET /billing/checkout` finds it on any device); nothing here
 * decides what is shown.
 *
 * No card data, client secret, plan or amount is ever stored here.
 */

const KEY = "webflix.checkout.v2";

export interface HandOff {
  accountId: string;
  checkoutId: string;
  /** What the provider's form was confirming: the card, or the first payment. */
  kind: "setup" | "payment";
}

/** A card change sent to the provider's form, so its result is looked at on the way back. */
export interface RememberedSetup {
  accountId: string;
  setupId: string;
  /** The membership was unpaid (grace or hold) when the card went to the provider. */
  recovering: boolean;
}

interface Stored {
  handOff?: HandOff;
  setup?: RememberedSetup;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(): Stored {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as Record<string, unknown>;
    const stored: Stored = {};
    const handOff = value.handOff as Partial<HandOff> | undefined;
    if (
      handOff &&
      typeof handOff.accountId === "string" &&
      typeof handOff.checkoutId === "string" &&
      (handOff.kind === "setup" || handOff.kind === "payment")
    ) {
      stored.handOff = {
        accountId: handOff.accountId,
        checkoutId: handOff.checkoutId,
        kind: handOff.kind,
      };
    }
    const setup = value.setup as Partial<RememberedSetup> | undefined;
    if (setup && typeof setup.accountId === "string" && typeof setup.setupId === "string") {
      stored.setup = {
        accountId: setup.accountId,
        setupId: setup.setupId,
        recovering: setup.recovering === true,
      };
    }
    return stored;
  } catch {
    return {};
  }
}

function write(next: Stored): void {
  try {
    if (!next.handOff && !next.setup) storage()?.removeItem(KEY);
    else storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode or full storage: the server still finds the checkout; only the "you came
    // back without a result" check is skipped.
  }
}

/** The checkout this browser sent to the provider's form, if it was this account's. */
export function handOffOf(accountId: string, checkoutId: string): HandOff["kind"] | null {
  const handOff = read().handOff;
  return handOff?.accountId === accountId && handOff.checkoutId === checkoutId
    ? handOff.kind
    : null;
}

export function markHandedOff(accountId: string, checkoutId: string, kind: HandOff["kind"]): void {
  write({ ...read(), handOff: { accountId, checkoutId, kind } });
}

export function clearHandOff(): void {
  const { setup } = read();
  write(setup ? { setup } : {});
}

export function rememberedSetup(accountId: string): RememberedSetup | null {
  const setup = read().setup;
  return setup?.accountId === accountId ? setup : null;
}

export function rememberSetup(setup: RememberedSetup): void {
  write({ ...read(), setup });
}

export function forgetSetup(): void {
  const { handOff } = read();
  write(handOff ? { handOff } : {});
}
