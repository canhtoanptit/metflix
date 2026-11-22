import { getRouteApi } from "@tanstack/react-router";
import { Button, RadioGroup, RadioItem } from "@webflix/ui";
import { type FormEvent, useState } from "react";
import { mockDescribeSecret, mockProviderConfirm } from "../../../mocks/billing.ts";
import { saveState } from "../../../mocks/state.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatMoney } from "../shared/format.ts";

const route = getRouteApi("/public/mock-pay");

const CARDS = [
  { value: "4242424242424242", label: "Visa •••• 4242: succeeds" },
  { value: "5555555555554444", label: "Mastercard •••• 4444: succeeds" },
  { value: "4000000000000002", label: "•••• 0002: declined" },
  { value: "4000000000009995", label: "•••• 9995: insufficient funds" },
  { value: "4000000000000069", label: "•••• 0069: expired card" },
  { value: "4000002500003155", label: "•••• 3155: asks for a challenge" },
] as const;

function back(returnPath: string | undefined, outcome: "succeeded" | "failed"): string | null {
  if (!returnPath?.startsWith("/") || returnPath.startsWith("//")) return null;
  return `${returnPath}${returnPath.includes("?") ? "&" : "?"}payment=${outcome}`;
}

/**
 * Mock mode only: a stand-in for the payment provider's hosted form (the real fake provider's
 * form is served by the API under `/_pay`). Same contract: a client secret in, the browser sent
 * back to `return` with `payment=succeeded`.
 */
export function MockProviderPage() {
  const search = route.useSearch();
  const secret = search.secret ?? "";
  const described = mockDescribeSecret(secret);
  const [card, setCard] = useState<string>(CARDS[0].value);
  const [stage, setStage] = useState<"form" | "challenge" | "declined">("form");
  const [busy, setBusy] = useState(false);

  const finish = (outcome: { status: string }) => {
    if (outcome.status === "succeeded") {
      const target = back(search.return, "succeeded");
      if (target) window.location.assign(target);
      return;
    }
    setBusy(false);
    setStage(outcome.status === "requires_action" ? "challenge" : "declined");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    finish(
      mockProviderConfirm(secret, { card: described?.kind === "payment" ? null : card }, saveState),
    );
  };

  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-canvas px-gutter py-12">
      <div className="flex w-full max-w-form flex-col gap-5 rounded-xl border border-line bg-surface-1 p-6">
        <p className="type-overline text-fg-subtle">Test payments · mock mode</p>
        {!described ? (
          <FormAlert title="Nothing to confirm">This payment link isn't valid.</FormAlert>
        ) : stage === "challenge" ? (
          <>
            <h1 className="type-title-lg text-fg">Confirm it's you</h1>
            <p className="type-body text-fg-muted">Your bank asks you to confirm (a test page).</p>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="accent"
                onClick={() =>
                  finish(mockProviderConfirm(secret, { challenge: "complete" }, saveState))
                }
              >
                Complete authentication
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  finish(mockProviderConfirm(secret, { challenge: "fail" }, saveState))
                }
              >
                Fail authentication
              </Button>
            </div>
          </>
        ) : stage === "declined" ? (
          <>
            <h1 className="type-title-lg text-fg">Card declined</h1>
            <p className="type-body text-fg-muted">The test card was refused.</p>
            <Button variant="primary" asChild>
              <a href={back(search.return, "failed") ?? "/"}>Back to Webflix</a>
            </Button>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <h1 className="type-title-lg text-fg">
              {described.kind === "payment"
                ? `Pay ${described.amountMinor === null ? "" : formatMoney({ amountMinor: described.amountMinor, currency: "USD" })}`
                : "Add a card"}
            </h1>
            {described.kind === "setup" ? (
              <RadioGroup aria-label="Test card" value={card} onValueChange={setCard}>
                {CARDS.map((item) => (
                  <RadioItem key={item.value} value={item.value} label={item.label} />
                ))}
              </RadioGroup>
            ) : (
              <p className="type-body text-fg-muted">Paid with the card you just added.</p>
            )}
            <Button type="submit" variant="accent" loading={busy}>
              {described.kind === "payment" ? "Pay" : "Save card"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
