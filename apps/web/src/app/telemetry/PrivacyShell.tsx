/**
 * The privacy part of the app shell, mounted once in the root layout: the telemetry runtime,
 * and the first-visit consent prompt (opt-in mode) or notice (opt-out mode).
 *
 * Who is asked, where, and when:
 * - a member on a profile without parental controls, while browsing: the home page and its
 *   views, search and My List. Those are the pages where activity is recorded, and pages that
 *   scroll, so the space the prompt takes is reserved at their end and nothing on them is out of
 *   reach. Nowhere else (an allowlist, so a screen added later stays quiet): not at Who's
 *   watching?, during sign-up, sign-in or checkout, on the account pages (Account › Privacy is
 *   the answer itself), over the player, and never on the payment provider's or the sign-in
 *   issuer's pages, which are not the app;
 * - never a kids or restricted profile (nothing is collected from it: nothing to answer), and
 *   never a signed-out visitor (in opt-in mode nothing is collected from an anonymous device, so
 *   there is nothing to ask);
 * - after the page has settled, never over its first paint; "Decide later" puts it off until the
 *   next visit (nothing is collected meanwhile in opt-in mode);
 * - out of sight, of the tab order and of screen readers while a dialog is open over the page.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Component, lazy, type ReactNode, Suspense, useEffect, useReducer, useState } from "react";
import { useSession } from "../session/session.ts";
import { consentOwner, consentQuery } from "./consent.ts";
import { browserGpc, effectivePurposes, isRestrictedProfile } from "./policy.ts";
import { TelemetryRuntimeMount } from "./react.tsx";

const ConsentPrompt = lazy(() =>
  import("./ConsentPrompt.tsx").then((module) => ({ default: module.ConsentPrompt })),
);

/** Where the prompt may appear: the browsing pages (and everything under them). */
const PROMPT_PATHS = ["/browse", "/search", "/my-list"];
/** How long the page settles before the prompt appears. */
const SETTLE_MS = 1200;

/** Whether the prompt may appear on this path. */
export function promptAllowedOn(pathname: string): boolean {
  return PROMPT_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export type PromptKind = "ask" | "notice";

const LATER_KEY = "webflix.privacy.later";
const NOTICE_KEY = "webflix.privacy.notice";

function readFlag(storage: () => Storage, key: string): boolean {
  try {
    return storage().getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(storage: () => Storage, key: string): void {
  try {
    storage().setItem(key, "1");
  } catch {
    // storage blocked: the prompt may come back on the next page load, nothing worse
  }
}

/** "Not now": until the browser session ends (sessionStorage), per account. */
export const promptMemory = {
  later: (owner: string) => readFlag(() => sessionStorage, `${LATER_KEY}.${owner}`),
  putOff: (owner: string) => writeFlag(() => sessionStorage, `${LATER_KEY}.${owner}`),
  /** The opt-out notice is shown once per account on this device. */
  noticed: (owner: string) => readFlag(() => localStorage, `${NOTICE_KEY}.${owner}`),
  notice: (owner: string) => writeFlag(() => localStorage, `${NOTICE_KEY}.${owner}`),
};

export function PrivacyShell() {
  return (
    <Quiet>
      <TelemetryRuntimeMount />
      <ConsentPromptGate />
    </Quiet>
  );
}

/**
 * Whatever goes wrong in here stays in here: the prompt or the runtime failing must never take
 * the page down with it (nothing is collected without them, which is the safe side).
 */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function ConsentPromptGate() {
  const session = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const owner = consentOwner(session);
  const eligible =
    session.authenticated &&
    session.activeProfile !== null &&
    !isRestrictedProfile(session.activeProfile) &&
    promptAllowedOn(pathname);
  // Read only: the telemetry runtime reads the consent once the page is idle.
  const { data: consent } = useQuery({ ...consentQuery(owner), enabled: false });
  const [dismissed, setDismissed] = useState(() => promptMemory.later(owner));
  // Remembering the notice lives in storage: re-render once it is written.
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => setDismissed(promptMemory.later(owner)), [owner]);

  let kind: PromptKind | null = null;
  if (eligible && consent && !dismissed) {
    if (consent.promptRequired) kind = "ask";
    else if (consent.mode === "opt-out" && !promptMemory.noticed(owner)) {
      const purposes = effectivePurposes(consent, browserGpc());
      // Nothing is collected (GPC, or an earlier "no"): nothing to tell.
      if (purposes.analytics || purposes.personalisation) kind = "notice";
    }
  }
  const settled = useSettled(kind !== null);
  if (!kind || !consent || !settled) return null;
  return (
    <Suspense fallback={null}>
      <ConsentPrompt
        kind={kind}
        consent={consent}
        onDone={(reason) => {
          if (kind === "notice") {
            promptMemory.notice(owner);
            rerender();
          }
          if (reason === "later") {
            promptMemory.putOff(owner);
            setDismissed(true);
          }
        }}
      />
    </Suspense>
  );
}

/** True once `active` has held for the settle delay. */
function useSettled(active: boolean): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!active) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [active]);
  return settled;
}
