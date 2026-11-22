import type { OidcIntent, OidcProvider } from "@webflix/contracts";
import { Button, ProviderMark } from "@webflix/ui";
import { useState } from "react";
import type { MockIssuerChoice } from "../../../mocks/identity.ts";
import { MemberHeader } from "../shared/Chrome.tsx";
import { hasProviderMark, providerName, withParams } from "./oidc.ts";

const CHOICES: Record<OidcIntent, Array<{ choice: MockIssuerChoice; label: string }>> = {
  signin: [
    { choice: "existing", label: "Sign in to the mock account" },
    { choice: "new", label: "A new member (creates an account)" },
    { choice: "link-required", label: "An account already uses this email" },
    { choice: "cancel", label: "Cancel" },
    { choice: "fail", label: "Fail" },
  ],
  link: [
    { choice: "confirm", label: "Link this account" },
    { choice: "in-use", label: "Already linked to another Webflix account" },
    { choice: "cancel", label: "Cancel" },
    { choice: "fail", label: "Fail" },
  ],
  reauth: [
    { choice: "confirm", label: "Sign in again (confirms it's you)" },
    { choice: "cancel", label: "Cancel" },
    { choice: "fail", label: "Fail" },
  ],
};

/**
 * Mock mode only (never in a production build): the stand-in for the provider's sign-in page.
 * The real modes use the development issuer at `/dev-idp/*`, which this does not imitate beyond
 * the outcomes it can produce. A choice updates the mock account and returns to the screen the
 * attempt came from, exactly as the server's callback would (`returnTo?oidc=<outcome>`).
 */
export function MockIssuer({
  provider,
  intent,
  returnTo,
}: {
  provider: OidcProvider;
  intent: OidcIntent;
  returnTo: string;
}) {
  const [busy, setBusy] = useState(false);
  const name = providerName(provider);
  const answer = async (choice: MockIssuerChoice) => {
    setBusy(true);
    const [{ loadState, saveState }, { completeMockFederation }] = await Promise.all([
      import("../../../mocks/state.ts"),
      import("../../../mocks/identity.ts"),
    ]);
    const state = loadState();
    const outcome = completeMockFederation(state, provider, intent, choice);
    saveState(state);
    // A full load, as after the real callback: the mock API reads the saved state again.
    window.location.assign(withParams(returnTo, { oidc: outcome }));
  };
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <MemberHeader />
      <main id="main" className="flex flex-1 justify-center px-gutter pt-6 pb-16">
        <section
          aria-labelledby="mock-issuer-heading"
          className="flex w-full max-w-form flex-col gap-5 rounded-2xl border border-line-subtle bg-surface-1 p-6 sm:p-10"
        >
          <div className="flex items-center gap-3">
            {hasProviderMark(provider) ? (
              <ProviderMark provider={provider} className="size-7" />
            ) : null}
            <h1 id="mock-issuer-heading" className="type-title-lg text-fg">
              Mock {name}
            </h1>
          </div>
          <p className="type-body text-fg-muted">
            Mock mode has no sign-in provider. Choose what {name} answers; you'll go back to Webflix
            as the real callback would send you.
          </p>
          <div className="flex flex-col gap-3">
            {CHOICES[intent].map((item) => (
              <Button
                key={item.choice}
                variant={item.choice === "cancel" || item.choice === "fail" ? "outline" : "primary"}
                size="lg"
                fullWidth
                disabled={busy}
                onClick={() => void answer(item.choice)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
