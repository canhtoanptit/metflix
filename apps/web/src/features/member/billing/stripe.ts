/**
 * The few parts of Stripe.js the payment form uses (docs/STRIPE.md §7, §15), typed here so the
 * app needs no Stripe package: the script is loaded from Stripe's own origin, only when the
 * deployment's provider is Stripe, and card details are typed into Stripe's iframe, never into
 * Webflix's page (principle 4).
 *
 * Not verified in this repository without a Stripe key: the browser half of the flow (mounting
 * the Payment Element, `confirmSetup`, `confirmPayment` and 3-D Secure in place). The server half
 * is proven against a Stripe sandbox (docs/STRIPE.md §6).
 */

export interface StripeError {
  type: string;
  code?: string;
  decline_code?: string;
  message?: string;
}

export interface StripePaymentElement {
  mount(element: HTMLElement): void;
  destroy(): void;
  on(
    event: "ready" | "change" | "loaderror",
    handler: (event: { complete?: boolean }) => void,
  ): void;
}

export interface StripeElements {
  create(type: "payment", options?: Record<string, unknown>): StripePaymentElement;
  submit(): Promise<{ error?: StripeError }>;
}

interface ConfirmResult {
  error?: StripeError;
}

export interface StripeJs {
  elements(options: { clientSecret: string; appearance?: Record<string, unknown> }): StripeElements;
  confirmSetup(options: {
    elements: StripeElements;
    confirmParams: { return_url: string };
    redirect: "if_required";
  }): Promise<ConfirmResult>;
  confirmPayment(options: {
    elements?: StripeElements;
    clientSecret?: string;
    confirmParams: { return_url: string };
    redirect: "if_required";
  }): Promise<ConfirmResult>;
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeJs;
  }
}

/**
 * Stripe's evergreen v3 script. The security headers allow `https://js.stripe.com` only when
 * Stripe is the configured provider (docs/STRIPE.md §15).
 */
const STRIPE_JS_URL = "https://js.stripe.com/v3/";

let loading: Promise<(publishableKey: string) => StripeJs> | null = null;

function loadScript(): Promise<(publishableKey: string) => StripeJs> {
  loading ??= new Promise((resolve, reject) => {
    if (window.Stripe) {
      resolve(window.Stripe);
      return;
    }
    const script = document.createElement("script");
    script.src = STRIPE_JS_URL;
    script.async = true;
    script.onload = () =>
      window.Stripe ? resolve(window.Stripe) : reject(new Error("Stripe.js did not start"));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Stripe.js could not be loaded"));
    };
    document.head.append(script);
  });
  return loading;
}

const instances = new Map<string, StripeJs>();

export async function loadStripe(publishableKey: string): Promise<StripeJs> {
  const existing = instances.get(publishableKey);
  if (existing) return existing;
  const factory = await loadScript();
  const stripe = factory(publishableKey);
  instances.set(publishableKey, stripe);
  return stripe;
}

/** The Payment Element in Webflix's colours (dark surfaces, the amber accent). */
export function stripeAppearance(): Record<string, unknown> {
  // Stripe's iframe cannot read our CSS variables: pass their computed values.
  const css = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const [name, token] of [
    ["colorPrimary", "--color-accent"],
    ["colorBackground", "--color-surface-1"],
    ["colorText", "--color-fg"],
    ["colorDanger", "--color-danger"],
    ["borderRadius", "--radius-control"],
  ] as const) {
    const value = css.getPropertyValue(token).trim();
    if (value) variables[name] = value;
  }
  return { theme: "night", variables };
}

/** Card refusals from Stripe.js, mapped to the decline reasons Webflix words for members. */
export function declineReasonOf(
  error: StripeError,
): "card_declined" | "insufficient_funds" | "expired_card" {
  const code = error.decline_code ?? error.code;
  if (code === "insufficient_funds") return "insufficient_funds";
  if (code === "expired_card") return "expired_card";
  return "card_declined";
}
