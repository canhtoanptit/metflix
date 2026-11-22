import { PaymentProviderError } from "@webflix/core";
import { FAKE_CARDS, FAKE_TEST_CARDS, type FakeTestCard, resolveTestCard } from "./cards.ts";
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
 * - `POST {base}/api/confirm`                  the same as JSON, for suites: `{ clientSecret, card?, challenge? }`
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
        return page(statusFor(error), "Cannot continue", `<p>${escapeHtml(messageFor(error))}</p>`);
      }
      throw error;
    }
  };

  async function confirm(
    secret: string,
    card: FakeTestCard | null,
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
    if (!described) return page(404, "Nothing to confirm", "<p>This link is not valid.</p>");
    const done =
      described.kind === "setup" ? described.status === "succeeded" : described.status !== "open";
    if (done) return finished(back, "succeeded");
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
</form>`,
    );
  }

  async function submitForm(request: Request, url: URL): Promise<Response> {
    const form = await readForm(request);
    const secret = form.get("secret") ?? "";
    const back = safeReturn(form.get("return"));
    const typed = (form.get("number") ?? "").trim();
    let card: FakeTestCard | null = null;
    if (typed !== "") {
      card = resolveTestCard(typed);
      if (!card) {
        return page(
          422,
          "Not a test card",
          `<p>Use one of the test cards listed on the form.</p><p><a href="${escapeHtml(formHref(secret, back))}">Back</a></p>`,
        );
      }
    } else if (form.get("card")) {
      card = resolveTestCard(form.get("card") ?? "");
    }
    const outcome = await confirm(secret, card);
    return afterConfirm(outcome, secret, back, url);
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
</form>`,
    );
  }

  async function submitChallenge(request: Request, url: URL): Promise<Response> {
    const form = await readForm(request);
    const secret = form.get("secret") ?? "";
    const back = safeReturn(form.get("return"));
    const outcome = await confirm(
      secret,
      null,
      form.get("outcome") === "fail" ? "fail" : "complete",
    );
    return afterConfirm(outcome, secret, back, url);
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
      return page(
        402,
        "Card declined",
        `<p>${escapeHtml(declineMessage(outcome.code))}</p><p><a href="${escapeHtml(formHref(secret, back))}">Try another card</a></p>`,
      );
    }
    return finished(back, "succeeded");
  }

  function finished(back: string | null, status: "succeeded"): Response {
    if (back) {
      const separator = back.includes("?") ? "&" : "?";
      return redirect(`${back}${separator}payment=${status}`);
    }
    return page(200, "Done", "<p>Confirmed. You can close this page.</p>");
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
    const card = typeof body.card === "string" ? resolveTestCard(body.card) : null;
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
