import type { Scenario } from "../context.ts";

/**
 * Blueprint §3: "Every mutating call takes an idempotency key derived from a Webflix operation
 * id." What Stripe does with a repeated key, a reused key with a different body, a repeated key
 * whose first attempt failed, and two concurrent requests with one key.
 */
export async function idempotency(s: Scenario): Promise<void> {
  const key = (name: string) => `webflix-proof-${s.runId}-${name}`;

  await s.step("same key, same body", async () => {
    const body = { email: `${s.name}-same@example.test`, metadata: { webflix_proof_run: s.runId } };
    const first = await s.stripe.customers.create(body, { idempotencyKey: key("same") });
    const second = await s.stripe.customers.create(body, { idempotencyKey: key("same") });
    s.own(first.id, second.id);
    s.record("first create", first);
    s.record("replayed create", second);
    const calls = s.calls.filter((c) => c.idempotencyKey === key("same"));
    s.expect("same object returned", second.id, first.id);
    s.expect(
      "Idempotent-Replayed header on the second response",
      calls.map((c) => c.replayed),
      [false, true],
    );
    s.observe(
      "distinct Request-Id values across the two responses",
      new Set(calls.map((c) => c.requestId)).size,
    );
  });

  await s.step("same key, different body", async () => {
    try {
      const customer = await s.stripe.customers.create(
        { email: `${s.name}-different@example.test` },
        { idempotencyKey: key("same") },
      );
      s.own(customer.id);
      s.observe("different body accepted", true, false);
    } catch (error) {
      const summary = s.recordError("reused key with a different body", error);
      s.observe("reused key with a different body", summary);
      s.expect("error type", summary.type, "StripeIdempotencyError");
    }
  });

  await s.step("same key after a declined payment", async () => {
    const params = {
      amount: 500,
      currency: "usd",
      payment_method: "pm_card_visa_chargeDeclined",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" as const },
      metadata: { webflix_proof_run: s.runId },
    };
    const outcomes = [];
    for (let i = 0; i < 2; i++) {
      try {
        const intent = await s.stripe.paymentIntents.create(params, {
          idempotencyKey: key("declined"),
        });
        s.own(intent.id);
        outcomes.push({ ok: true, status: intent.status });
      } catch (error) {
        const raw = (error as { raw?: { payment_intent?: { id?: string } } }).raw;
        s.own(raw?.payment_intent?.id);
        outcomes.push({ ok: false, ...s.recordError(`declined payment, attempt ${i + 1}`, error) });
      }
    }
    const calls = s.calls.filter((c) => c.idempotencyKey === key("declined"));
    s.observe("declined twice with one key", {
      outcomes,
      replayed: calls.map((c) => c.replayed),
      statuses: calls.map((c) => c.status),
    });
  });

  await s.step("two concurrent requests with one key", async () => {
    const body = { email: `${s.name}-concurrent@example.test` };
    const results = await Promise.allSettled([
      s.stripe.customers.create(body, { idempotencyKey: key("concurrent") }),
      s.stripe.customers.create(body, { idempotencyKey: key("concurrent") }),
    ]);
    for (const r of results) if (r.status === "fulfilled") s.own(r.value.id);
    const calls = s.calls.filter((c) => c.idempotencyKey === key("concurrent"));
    s.observe(
      "concurrent outcomes",
      {
        results: results.map((r) =>
          r.status === "fulfilled"
            ? { ok: true, id: r.value.id }
            : { ok: false, error: String((r.reason as Error).message) },
        ),
        http: calls.map((c) => ({ status: c.status, replayed: c.replayed })),
      },
      undefined,
      "stripe-node retries a 409 idempotency_key_in_use, so both may succeed",
    );
  });

  await s.step("keys the library adds by itself", async () => {
    const customer = await s.stripe.customers.create({ email: `${s.name}-auto@example.test` });
    s.own(customer.id);
    const call = s.calls.filter((c) => c.method === "POST" && c.path === "/v1/customers").at(-1);
    s.observe(
      "idempotency key sent without one being passed",
      call?.idempotencyKey?.replace(/[0-9a-f-]{36}$/, "<uuid>") ?? null,
    );
  });
}
