/**
 * The first-visit consent prompt (opt-in mode: nothing is collected until a purpose is granted)
 * and notice (opt-out mode: collected until turned off). A compact bar at the bottom of the
 * browsing pages, never a wall:
 * - the page stays usable behind it, and the space it takes is reserved at the end of the page,
 *   so nothing on the page is out of reach (scroll, and everything comes out from under it);
 * - it sits above a bar fixed to the bottom of the screen (the phone tab bar), never over it;
 * - while a dialog is open over the page it is hidden (by CSS alone): out of sight, of the tab
 *   order and of screen readers, as the rest of the page is;
 * - it waits as long as the member likes, and saying no takes exactly as much as saying yes: two
 *   equal buttons side by side, and the same third way (choose per purpose) for both.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import type { ConsentState } from "@webflix/contracts";
import { CloseIcon, cx, IconButton, Switch, toast } from "@webflix/ui";
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BusyButton, focusMainContent } from "./BusyButton.tsx";
import { useAnswerConsent } from "./consent.ts";
import { KEPT_AFTER_REFUSAL, PURPOSE_COPY, PURPOSE_ORDER, WHAT_IS_RECORDED } from "./copy.ts";
import type { PromptKind } from "./PrivacyShell.tsx";
import { browserGpc, effectivePurposes, type Purposes } from "./policy.ts";

export function ConsentPrompt({
  kind,
  consent,
  onDone,
}: {
  kind: PromptKind;
  consent: ConsentState;
  /** `answered`: an answer was recorded; `later`: put off; `acknowledged`: the notice was read. */
  onDone: (reason: "answered" | "later" | "acknowledged") => void;
}) {
  const headingId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const { answer, pending, error } = useAnswerConsent();
  const [choosing, setChoosing] = useState(false);
  const [choices, setChoices] = useState<Purposes>(() =>
    kind === "notice"
      ? effectivePurposes(consent, browserGpc())
      : // Opt-in: nothing is ticked for the member.
        { analytics: false, personalisation: false },
  );
  const lift = useBottomBarLift(panelRef);
  useReservedSpace(panelRef, lift);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const choicesRef = useRef<HTMLFieldSetElement>(null);
  // Focus follows what the member opened or closed (UX review 2.7): the first switch when the
  // choices open, the button that opened them when they close.
  const [moveFocus, setMoveFocus] = useState<"choices" | "choose" | null>(null);
  useEffect(() => {
    if (moveFocus === "choices")
      choicesRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
    if (moveFocus === "choose") chooseRef.current?.focus();
    if (moveFocus) setMoveFocus(null);
  }, [moveFocus]);

  /** The prompt is going: focus moves to the page it stood in front of. */
  const finish = (reason: "answered" | "later" | "acknowledged") => {
    onDone(reason);
    focusMainContent();
  };

  const save = async (answers: Purposes) => {
    if (pending !== null) return;
    try {
      await answer(answers, "banner");
    } catch {
      return; // shown below; the prompt stays
    }
    const any = answers.analytics || answers.personalisation;
    toast.success(any ? "Thanks, your choice is saved" : "Your choice is saved", {
      description: any
        ? "You can change this any time in Account › Privacy."
        : `${KEPT_AFTER_REFUSAL} You can change this any time in Account › Privacy.`,
    });
    finish("answered");
  };

  const ask = kind === "ask";
  const busy = pending !== null;
  const equal = "min-w-28 flex-1 md:flex-none";

  return (
    <section
      ref={panelRef}
      aria-labelledby={headingId}
      // Under a dialog (Radix hides the app's root from assistive technology, and a modal locks
      // the body): hidden like the rest of the page, so out of sight, of Tab and of screen
      // readers. Pure CSS: nothing runs when a dialog opens or closes.
      className={cx(
        "pointer-events-none fixed inset-x-0 bottom-0 z-(--z-preview) px-gutter pb-3 sm:pb-5",
        "in-[[aria-hidden=true]]:invisible in-[[data-scroll-locked]]:invisible in-[[inert]]:invisible",
      )}
      style={lift > 0 ? { bottom: `${lift}px` } : undefined}
    >
      <div className="pointer-events-auto relative mx-auto flex w-full max-w-page animate-slide-up flex-col gap-4 rounded-dialog border border-line-subtle bg-surface-2 p-4 pe-12 shadow-xl sm:p-5 sm:pe-14">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-8">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 id={headingId} className="type-label text-fg">
              {ask ? "Your viewing data, your choice" : "Webflix learns from what you browse"}
            </h2>
            <IconButton
              icon={CloseIcon}
              label={ask ? "Decide later" : "Close"}
              variant="ghost"
              size="sm"
              className="absolute end-2 top-2 sm:end-3 sm:top-3"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) finish(ask ? "later" : "acknowledged");
              }}
            />
            <p className="max-w-prose type-body-sm text-fg-muted">
              {ask ? "With your permission, Webflix records " : "Webflix records "}
              {lowerFirst(WHAT_IS_RECORDED).replace(/\.$/, ",")} to recommend titles for you and to
              make Webflix better.{" "}
              {ask ? "Without it, everything still works." : "It's on unless you turn it off."}{" "}
              Change this any time in{" "}
              <Link to="/account/privacy" className="focus-ring rounded-xs text-fg underline">
                Account › Privacy
              </Link>
              .
            </p>
          </div>
          {choosing ? null : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:shrink-0 md:flex-nowrap">
              {ask ? (
                <>
                  <BusyButton
                    variant="primary"
                    className={equal}
                    busy={busy}
                    onClick={() => save({ analytics: true, personalisation: true })}
                  >
                    Allow
                  </BusyButton>
                  <BusyButton
                    variant="primary"
                    className={equal}
                    busy={busy}
                    onClick={() => save({ analytics: false, personalisation: false })}
                  >
                    Don't allow
                  </BusyButton>
                </>
              ) : (
                <>
                  <BusyButton
                    variant="primary"
                    className={equal}
                    busy={busy}
                    onClick={() => finish("acknowledged")}
                  >
                    Keep it on
                  </BusyButton>
                  <BusyButton
                    variant="primary"
                    className={equal}
                    busy={busy}
                    onClick={() => save({ analytics: false, personalisation: false })}
                  >
                    Turn it off
                  </BusyButton>
                </>
              )}
              <BusyButton
                ref={chooseRef}
                variant="link"
                size="sm"
                aria-expanded={false}
                busy={busy}
                onClick={() => {
                  setChoosing(true);
                  setMoveFocus("choices");
                }}
                className="min-h-6 w-full md:w-auto"
              >
                Choose for each use
              </BusyButton>
            </div>
          )}
        </div>

        {choosing ? (
          <>
            <fieldset
              ref={choicesRef}
              className="grid gap-4 rounded-lg bg-surface-1 p-4 md:grid-cols-2 md:gap-8"
            >
              <legend className="sr-only">Choose for each use</legend>
              {PURPOSE_ORDER.map((purpose) => (
                <Switch
                  key={purpose}
                  label={PURPOSE_COPY[purpose].label}
                  description={PURPOSE_COPY[purpose].description}
                  checked={choices[purpose]}
                  onCheckedChange={(checked) => {
                    if (!busy) setChoices((current) => ({ ...current, [purpose]: checked }));
                  }}
                />
              ))}
            </fieldset>
            <div className="flex flex-wrap items-center gap-3">
              <BusyButton variant="primary" busy={busy} onClick={() => save(choices)}>
                Save choices
              </BusyButton>
              <BusyButton
                variant="link"
                size="sm"
                aria-expanded={true}
                busy={busy}
                className="min-h-6"
                onClick={() => {
                  setChoosing(false);
                  setMoveFocus("choose");
                }}
              >
                Back
              </BusyButton>
            </div>
          </>
        ) : null}

        {error ? (
          <p role="alert" className="type-body-sm text-danger">
            Your answer wasn't saved. Check your connection and try again.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The height of a bar fixed to the bottom edge of the screen under the panel (the browse tab bar
 * on phones), so the panel sits above it: whatever is topmost at the bottom edge, other than the
 * panel itself, inside an element fixed there. Measured again on resize and on navigation.
 */
function useBottomBarLift(ref: RefObject<HTMLElement | null>): number {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      try {
        setLift(Math.round(bottomBarHeight(ref.current)));
      } catch {
        // No layout to probe (a test DOM, an old engine): the panel stays at the bottom edge.
      }
    };
    measure();
    // The page settles (the tab bar mounts with the browse shell) after the panel appears.
    const settle = window.setTimeout(measure, 300);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("resize", measure);
    };
  }, [ref, pathname]);
  return lift;
}

/** The height of what is fixed to the bottom edge under the panel (0 when nothing is). */
function bottomBarHeight(self: HTMLElement | null): number {
  const bottom = window.innerHeight - 1;
  let height = 0;
  for (const x of [0.25, 0.5, 0.75].map((share) => window.innerWidth * share)) {
    const below = document.elementsFromPoint(x, bottom).find((element) => !self?.contains(element));
    for (let node = below ?? null; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).position !== "fixed") continue;
      const box = node.getBoundingClientRect();
      if (box.bottom >= bottom && box.height < window.innerHeight / 3) {
        height = Math.max(height, window.innerHeight - box.top);
      }
      break;
    }
  }
  return height;
}

/**
 * While the panel is shown: room for it at the end of the page (whatever it covers can be
 * scrolled out from under it), and toasts lifted above it (`--wf-toast-offset`, packages/ui).
 *
 * Written once when the panel appears (and again only if it changes size), never on a dialog
 * opening or closing over it: a custom property on the root restyles the whole document and the
 * body's padding re-lays it out, which made opening a title's details visibly slower (measured:
 * about 35 ms more at a 4x slowed CPU, all of it style recalculation). Under a dialog the page
 * is locked anyway, so the room left at its end costs nothing.
 */
function useReservedSpace(ref: RefObject<HTMLElement | null>, lift: number): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const body = document.body;
    const previousPadding = body.style.paddingBottom;
    let applied = -1;
    const apply = () => {
      const height = element.offsetHeight + lift;
      // A hidden panel (under a dialog) measures 0 in some engines: keep what is reserved.
      if (height <= lift || height === applied) return;
      applied = height;
      root.style.setProperty("--wf-toast-offset", `${height}px`);
      body.style.paddingBottom = `${height}px`;
    };
    apply();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--wf-toast-offset");
      body.style.paddingBottom = previousPadding;
    };
  }, [ref, lift]);
}
