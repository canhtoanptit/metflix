import { PaymentProviderError } from "@webflix/core";
import { FAKE_CARDS, FAKE_TEST_CARDS, type FakeCardChoice, parseCardChoice } from "./cards.ts";
import type { DeliveryPolicy, FakePaymentProvider, FormOutcome } from "./provider.ts";

export interface FakePaymentFormOptions {
  provider: FakePaymentProvider;
  /** Where the form is mounted (`/_pay`, docs/BLUEPRINT-M2.md §5.5). */
  basePath?: string;
}

/**
 * The fake provider's payment form, served from its own path (`/_pay/*`) so that card data in
 * local modes goes to the simulator and never to the API (principle 4). It plays the part of
 * Stripe's Payment Element and its 3-D Secure page: the browser confirms a setup or a first
 * payment with a client secret (the capability, as at Stripe), a challenge page completes or
 * fails authentication, and the browser is sent back to a same-origin path.
 *
 * - `GET  {base}/form?secret=…&return=/path`   the form (test cards by name or number)
 * - `POST {base}/form`                         confirm (form post); 303 to the challenge or back
 * - `GET|POST {base}/challenge`                the 3-D Secure stand-in: complete or fail
 *
 * Like a real provider's hosted page, it always leads back: with a `return` path the browser
 * is sent there with `payment=succeeded` or `payment=failed` (a decline, a failed challenge, a
 * payment that can no longer be made), and every problem page links back with `payment=failed`.
 * A declined card can be followed by another on the same page (the setup or the first payment
 * stays confirmable, as at Stripe); a second submission of something already confirmed is sent
 * back as succeeded.
 * - `POST {base}/api/confirm`                  the same as JSON, for suites: `{ clientSecret, card?, challenge? }`
 *
 * A card is a test card by name or number, or a labelled one, `visa:run-42`: the same behaviour
 * with its own fingerprint (a card that never had a trial, for suites that rerun on one
 * database); the same label is the same card again.
 * - `GET {base}/api/cards`                     the test cards
 * - `GET|PUT {base}/api/delivery`, `POST {base}/api/deliver`   webhook delivery: policy, flush
 *
 * Never mounted in production. The JSON control endpoints require `Content-Type:
 * application/json`, which a cross-site form cannot send without a preflight.
 */
export function createFakePaymentForm(
  options: FakePaymentFormOptions,
): (request: Request) => Promise<Response | null> {
  const base = (options.basePath ?? "/_pay").replace(/\/$/, "");
  const fake = options.provider;

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
    const path = url.pathname.slice(base.length) || "/";
    try {
      if (path === "/form" && request.method === "GET") return await formPage(url);
      if (path === "/form" && request.method === "POST") return await submitForm(request, url);
      if (path === "/challenge" && request.method === "GET") return challengePage(url);
      if (path === "/challenge" && request.method === "POST")
        return await submitChallenge(request, url);
      if (path === "/api/cards" && request.method === "GET") {
        return json(
          FAKE_TEST_CARDS.map((name) => ({
            name,
            number: FAKE_CARDS[name].number,
            label: FAKE_CARDS[name].label,
          })),
        );
      }
      if (path === "/api/confirm" && request.method === "POST") return await apiConfirm(request);
      if (path === "/api/delivery" && request.method === "GET")
        return json(await fake.deliveryPolicy());
      if (path === "/api/delivery" && request.method === "PUT") return await apiDelivery(request);
      if (path === "/api/deliver" && request.method === "POST") {
        if (!isJson(request)) return unsupported();
        return json(await fake.deliverPending());
      }
      return page(404, "Not found", "<p>This page does not exist.</p>");
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        if (path.startsWith("/api/")) return json({ error: error.code }, statusFor(error));
        const back = safeReturn(url.searchParams.get("return"));
        return page(
          statusFor(error),
          "Cannot continue",
          `<p>${escapeHtml(messageFor(error))}</p>${backLink(back)}`,
        );
      }
      throw error;
    }
  };

  async function confirm(
    secret: string,
    card: FakeCardChoice | null,
    challenge?: "complete" | "fail",
  ): Promise<FormOutcome> {
    const described = await fake.describeSecret(secret);
    if (!described) throw new PaymentProviderError("not_found");
    const settings = challenge ? { challenge } : {};
    return described.kind === "setup"
      ? fake.confirmSetup(secret, card, settings)
      : fake.confirmPayment(secret, card, settings);
  }

  async function formPage(url: URL): Promise<Response> {
    const secret = url.searchParams.get("secret") ?? "";
    const back = safeReturn(url.searchParams.get("return"));
    const described = await fake.describeSecret(secret);
    if (!described) {
      return page(404, "Nothing to confirm", `<p>This link is not valid.</p>${backLink(back)}`);
    }
    const settled = settledOutcome(described);
    if (settled) return finished(back, settled);
    const heading =
      described.kind === "setup"
        ? "Add a card"
        : `Pay ${formatMoney(described.amountMinor, described.currency)}`;
    const onFile =
      described.kind === "payment" && described.cardOnFile
        ? `<label class="card"><input type="radio" name="card" value="" checked> Card on file: ${escapeHtml(described.cardOnFile.brand)} ending ${escapeHtml(described.cardOnFile.last4)}</label>`
        : "";
    const cards = FAKE_TEST_CARDS.map(
      (name, index) =>
        `<label class="card"><input type="radio" name="card" value="${name}"${!onFile && index === 0 ? " checked" : ""}> <code>${FAKE_CARDS[name].number.replace(/(\d{4})(?=\d)/g, "$1 ")}</code> ${escapeHtml(FAKE_CARDS[name].label)}</label>`,
    ).join("");
    return page(
      200,
      heading,
      `<p class="note">Test payments: no real card is accepted and nothing is charged.</p>
<form method="post" action="${base}/form">
<input type="hidden" name="secret" value="${escapeHtml(secret)}">
<input type="hidden" name="return" value="${escapeHtml(back ?? "")}">
<fieldset><legend>Choose a test card</legend>${onFile}${cards}</fieldset>
<label class="number">Or type a test card number <input name="number" inputmode="numeric" autocomplete="off"></label>
<button type="submit">${described.kind === "setup" ? "Save card" : "Pay"}</button>
</form>${backLink(back, "Cancel and return")}`,
    );
  }

  async function submitForm(request: Request, url: URL): Promise<Response> {
    const form = await readForm(request);
    const secret = form.get("secret") ?? "";
    const back = safeReturn(form.get("return"));
    const typed = (form.get("number") ?? "").trim();
    let card: FakeCardChoice | null = null;
    if (typed !== "") {
      card = parseCardChoice(typed)?.choice ?? null;
      if (!card) {
        return page(
          422,
          "Not a test card",
          `<p>Use one of the test cards listed on the form.</p><p><a href="${escapeHtml(formHref(secret, back))}">Try another card</a></p>${backLink(back)}`,
        );
      }
    } else if (form.get("card")) {
      card = parseCardChoice(form.get("card") ?? "")?.choice ?? null;
    }
    return confirmed(secret, back, url, () => confirm(secret, card));
  }

  /**
   * Confirms unless it is already settled (a second submission: sent back as it ended), and
   * turns a refusal into a page that leads back instead of a dead end.
   */
  async function confirmed(
    secret: string,
    back: string | null,
    url: URL,
    run: () => Promise<FormOutcome>,
  ): Promise<Response> {
    const described = await fake.describeSecret(secret);
    if (!described) {
      return page(404, "Nothing to confirm", `<p>This link is not valid.</p>${backLink(back)}`);
    }
    const settled = settledOutcome(described);
    if (settled) return finished(back, settled);
    try {
      return afterConfirm(await run(), secret, back, url);
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) throw error;
      const retry = `<p><a href="${escapeHtml(formHref(secret, back))}">Try again</a></p>`;
      return page(
        statusFor(error),
        "Cannot continue",
        `<p>${escapeHtml(messageFor(error))}</p>${retry}${backLink(back)}`,
      );
    }
  }

  function challengePage(url: URL): Response {
    const secret = url.searchParams.get("secret") ?? "";
    const back = safeReturn(url.searchParams.get("return"));
    return page(
      200,
      "Confirm it's you",
      `<p>Your bank asks you to confirm this payment (a 3-D Secure test page).</p>
<form method="post" action="${base}/challenge">
<input type="hidden" name="secret" value="${escapeHtml(secret)}">
<input type="hidden" name="return" value="${escapeHtml(back ?? "")}">
<button type="submit" name="outcome" value="complete">Complete authentication</button>
<button type="submit" name="outcome" value="fail" class="secondary">Fail authentication</button>
</form>${backLink(back, "Cancel and return")}`,
    );
  }

  async function submitChallenge(request: Request, url: URL): Promise<Response> {
    const form = await readForm(request);
    const secret = form.get("secret") ?? "";
    const back = safeReturn(form.get("return"));
    const challenge = form.get("outcome") === "fail" ? "fail" : "complete";
    return confirmed(secret, back, url, () => confirm(secret, null, challenge));
  }

  function afterConfirm(
    outcome: FormOutcome,
    secret: string,
    back: string | null,
    url: URL,
  ): Response {
    if (outcome.status === "requires_action") {
      const target = new URL(`${base}/challenge`, url);
      target.searchParams.set("secret", secret);
      if (back) target.searchParams.set("return", back);
      return redirect(`${target.pathname}${target.search}`);
    }
    if (outcome.status === "failed") {
      // Back to the merchant, who reports the decline (and offers the form again).
      if (back) return finished(back, "failed");
      return page(
        402,
        "Card declined",
        `<p>${escapeHtml(declineMessage(outcome.code))}</p><p><a href="${escapeHtml(formHref(secret, back))}">Try another card</a></p>`,
      );
    }
    return finished(back, "succeeded");
  }

  function finished(back: string | null, status: "succeeded" | "failed"): Response {
    if (back) return redirect(returnHref(back, status));
    return status === "succeeded"
      ? page(200, "Done", "<p>Confirmed. You can close this page.</p>")
      : page(402, "Not paid", "<p>This payment can no longer be made.</p>");
  }

  function formHref(secret: string, back: string | null): string {
    const params = new URLSearchParams({ secret });
    if (back) params.set("return", back);
    return `${base}/form?${params}`;
  }

  async function apiConfirm(request: Request): Promise<Response> {
    if (!isJson(request)) return unsupported();
    const body = (await request.json().catch(() => null)) as {
      clientSecret?: unknown;
      card?: unknown;
      challenge?: unknown;
    } | null;
    if (typeof body?.clientSecret !== "string") return json({ error: "invalid_request" }, 400);
    const card =
      typeof body.card === "string" ? (parseCardChoice(body.card)?.choice ?? null) : null;
    if (typeof body.card === "string" && !card) return json({ error: "unknown_test_card" }, 422);
    const challenge =
      body.challenge === "complete" || body.challenge === "fail" ? body.challenge : undefined;
    return json(await confirm(body.clientSecret, card, challenge));
  }

  async function apiDelivery(request: Request): Promise<Response> {
    if (!isJson(request)) return unsupported();
    const body = (await request.json().catch(() => null)) as Partial<
      Record<string, unknown>
    > | null;
    const policy = parsePolicy(body);
    if (!policy) return json({ error: "invalid_request" }, 400);
    await fake.setDeliveryPolicy(policy);
    return json(policy);
  }
}

function parsePolicy(body: Partial<Record<string, unknown>> | null): DeliveryPolicy | null {
  if (body?.mode === "orderly" || body?.mode === "outage") return { mode: body.mode };
  if (body?.mode !== "unruly") return null;
  const duplicateRate = typeof body.duplicateRate === "number" ? body.duplicateRate : 0.2;
  const maxDelayMs = typeof body.maxDelayMs === "number" ? body.maxDelayMs : 2_000;
  if (duplicateRate < 0 || duplicateRate > 1 || maxDelayMs < 0 || maxDelayMs > 3_600_000)
    return null;
  return {
    mode: "unruly",
    duplicateRate,
    maxDelayMs,
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
  };
}

/**
 * How a confirmation already ended, or null while it can still be confirmed: a setup that
 * succeeded, a first payment paid (succeeded) or no longer payable (voided: failed). A declined
 * setup or an open invoice can take another card.
 */
function settledOutcome(
  described: NonNullable<Awaited<ReturnType<FakePaymentProvider["describeSecret"]>>>,
): "succeeded" | "failed" | null {
  if (described.kind === "setup") return described.status === "succeeded" ? "succeeded" : null;
  if (described.status === "open") return null;
  return described.status === "paid" ? "succeeded" : "failed";
}

function returnHref(back: string, status: "succeeded" | "failed"): string {
  const separator = back.includes("?") ? "&" : "?";
  return `${back}${separator}payment=${status}`;
}

/** The way back to the merchant from any page, the outcome marked failed. */
function backLink(back: string | null, label = "Return to Webflix"): string {
  return back
    ? `<p><a class="back" href="${escapeHtml(returnHref(back, "failed"))}">${escapeHtml(label)}</a></p>`
    : "";
}

/** Only a same-origin absolute path: never another origin, a scheme or a protocol-relative URL. */
function safeReturn(value: string | null | undefined): string | null {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) {
    return null;
  }
  return value.slice(0, 512);
}

async function readForm(request: Request): Promise<Map<string, string>> {
  const fields = new Map<string, string>();
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) return fields;
  const text = (await request.text()).slice(0, 16 * 1024);
  for (const [name, value] of new URLSearchParams(text)) fields.set(name, value);
  return fields;
}

function isJson(request: Request): boolean {
  return /^application\/json\b/i.test(request.headers.get("Content-Type") ?? "");
}

function statusFor(error: PaymentProviderError): number {
  if (error.code === "not_found") return 404;
  if (error.code === "unavailable" || error.code === "rate_limited") return 503;
  return 400;
}

function messageFor(error: PaymentProviderError): string {
  if (error.code === "not_found") return "This link is not valid.";
  if (error.code === "invalid_request") return "This payment is already complete.";
  return "Something went wrong. Try again.";
}

function declineMessage(code: string): string {
  switch (code) {
    case "insufficient_funds":
      return "The card has insufficient funds.";
    case "expired_card":
      return "The card has expired.";
    case "incorrect_cvc":
      return "The security code is incorrect.";
    case "processing_error":
      return "The card could not be processed. Try again.";
    case "authentication_required":
      return "Authentication failed.";
    default:
      return "The card was declined.";
  }
}

function formatMoney(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Test payments</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#141414;color:#eee;margin:0;padding:24px}
main{max-width:520px;margin:0 auto;background:#1f1f1f;border-radius:8px;padding:24px}
h1{font-size:22px;margin:0 0 12px}.note{color:#aaa;font-size:14px}
fieldset{border:1px solid #333;border-radius:6px;margin:16px 0;padding:8px 12px}
.card{display:block;padding:6px 0}code{color:#fff}
.number{display:block;margin:12px 0}.number input{display:block;width:100%;padding:8px;margin-top:4px;background:#111;color:#eee;border:1px solid #444;border-radius:4px}
button{background:#ffa31a;color:#1a1003;border:0;border-radius:4px;padding:10px 18px;font-size:16px;margin:8px 8px 0 0;cursor:pointer}
button.secondary{background:#444}a{color:#fff}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...SECURITY_HEADERS } });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
  });
}

function unsupported(): Response {
  return json({ error: "send application/json" }, 415);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
