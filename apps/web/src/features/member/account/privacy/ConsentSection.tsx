/**
 * Account › Privacy, "How Webflix uses your activity": the consent in force per purpose, why it
 * is what it is (your answer, the service's default, your browser's Global Privacy Control), and
 * a switch to change it. Turning a purpose off applies at once in this browser (whatever was
 * waiting to be sent is dropped) and the server records it; turning one on takes effect once the
 * server has recorded it.
 */
import { useQuery } from "@tanstack/react-query";
import type { ConsentPurpose, ConsentState } from "@webflix/contracts";
import { Button, ErrorState, Skeleton, Switch, toast } from "@webflix/ui";
import { useState } from "react";
import { describeError } from "../../../../app/query/errors.ts";
import {
  CONSENT_TOAST_ID,
  KEPT_REGARDLESS,
  PURPOSE_COPY,
  PURPOSE_ORDER,
  WHAT_IS_RECORDED,
  WITHOUT_PERSONALISATION,
} from "../../../../app/telemetry/copy.ts";
import {
  browserGpc,
  effectivePurposes,
  useAnswerConsent,
  useConsent,
} from "../../../../app/telemetry/index.ts";
import { FormAlert } from "../../shared/FormAlert.tsx";
import { formatLongDate } from "../../shared/format.ts";
import { describeMemberError } from "../../shared/privileges.ts";
import { AccountSection } from "../AccountLayout.tsx";
import { formatRetention, privacyRequestsQuery } from "./requests.ts";

export function ConsentSection() {
  const consent = useConsent();
  return (
    <AccountSection
      title="How Webflix uses your activity"
      description={
        consent.data?.mode === "off"
          ? undefined
          : consent.data?.mode === "opt-out"
            ? `Webflix records ${lowerFirst(WHAT_IS_RECORDED)} You can turn this off below.`
            : `With your permission, Webflix records ${lowerFirst(WHAT_IS_RECORDED)}`
      }
    >
      {consent.isPending ? (
        <div className="flex flex-col gap-5" aria-busy="true">
          {[0, 1].map((key) => (
            <div key={key} className="flex items-start justify-between gap-6">
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-full max-w-sm" />
              </div>
              <Skeleton className="h-6 w-10.5" radius="full" />
            </div>
          ))}
        </div>
      ) : consent.isError ? (
        <ErrorState
          layout="inline"
          title="We couldn't load your choices"
          description={`${describeError(consent.error).description} Until then, nothing is recorded in this browser.`}
          action={
            <Button variant="accent" onClick={() => void consent.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <ConsentChoices consent={consent.data} />
      )}
    </AccountSection>
  );
}

function ConsentChoices({ consent }: { consent: ConsentState }) {
  const { answer } = useAnswerConsent();
  // This deployment's retention, served with the privacy requests (the same page reads them).
  const terms = useQuery(privacyRequestsQuery()).data?.terms;
  // What the member just asked for, shown at once while the server records it.
  const [asked, setAsked] = useState<Partial<Record<ConsentPurpose, boolean>>>({});
  const browserSignal = browserGpc();
  const gpc = browserSignal || consent.gpc;
  // What is in force in this browser (GPC honoured even where the server did not see it).
  const effective = effectivePurposes(consent, browserSignal);

  if (consent.mode === "off") {
    return (
      <FormAlert tone="info" title="Nothing to choose on this service">
        This Webflix service doesn't record what you browse and play for recommendations or to
        improve Webflix. It keeps only what it needs to work, like your watch history, ratings and
        My List, and your rows come from those and from what's new and popular.
      </FormAlert>
    );
  }

  const change = async (purpose: ConsentPurpose, granted: boolean) => {
    // The switch keeps focus and stays enabled while saving (UX review 2.7): a change asked for
    // meanwhile is ignored, and the line under it says "Saving…".
    if (asked[purpose] !== undefined) return;
    setAsked((current) => ({ ...current, [purpose]: granted }));
    try {
      await answer({ [purpose]: granted }, "settings");
      toast.success(`${PURPOSE_COPY[purpose].label} turned ${granted ? "on" : "off"}`, {
        id: CONSENT_TOAST_ID,
      });
    } catch (error) {
      toast.error(
        `Couldn't turn ${PURPOSE_COPY[purpose].label.toLowerCase()} ${granted ? "on" : "off"}`,
        { id: CONSENT_TOAST_ID, description: describeMemberError(error).description },
      );
    } finally {
      setAsked(({ [purpose]: _done, ...rest }) => rest);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {gpc ? (
        <FormAlert tone="info" title="Your browser sends Global Privacy Control">
          Webflix treats it as a no for anything you haven't answered yourself. Turning a choice on
          here is your own answer, and it counts over the browser's signal.
        </FormAlert>
      ) : null}
      <ul className="flex flex-col divide-y divide-line-subtle">
        {PURPOSE_ORDER.map((purpose) => {
          const state = consent.purposes[purpose];
          const pending = asked[purpose];
          const checked = pending ?? effective[purpose];
          return (
            <li key={purpose} className="flex flex-col gap-1.5 py-4 first:pt-0 last:pb-0">
              <Switch
                label={PURPOSE_COPY[purpose].label}
                description={PURPOSE_COPY[purpose].description}
                checked={checked}
                onCheckedChange={(next) => void change(purpose, next)}
              />
              <p className="type-caption text-fg-subtle" aria-live="polite">
                {pending !== undefined
                  ? "Saving…"
                  : describeSource(consent.mode, effective[purpose], state.source, state.updatedAt)}
              </p>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 type-body-sm text-fg-muted">
        <p>{WITHOUT_PERSONALISATION}</p>
        <p>
          {KEPT_REGARDLESS}
          {terms
            ? ` What is recorded for these two uses is deleted after ${formatRetention(terms.eventsRetentionDays)}, and totals made from it after ${formatRetention(terms.aggregatesRetentionDays)}.`
            : null}
        </p>
      </div>
    </div>
  );
}

/** Why a purpose is on or off, in a few words. */
function describeSource(
  mode: ConsentState["mode"],
  granted: boolean,
  source: ConsentState["purposes"]["analytics"]["source"],
  updatedAt: string | null,
): string {
  const on = updatedAt ? ` on ${formatLongDate(updatedAt)}` : "";
  switch (source) {
    case "banner":
    case "settings":
      return `Turned ${granted ? "on" : "off"} by you${on}.`;
    case "gpc":
      return "Off because your browser sends Global Privacy Control.";
    case "support":
      // Staff can only record a withdrawal (a grant from support is never in force).
      return granted ? defaultSource(mode, granted) : `Turned off by Webflix support${on}.`;
    default:
      return defaultSource(mode, granted);
  }
}

function defaultSource(mode: ConsentState["mode"], granted: boolean): string {
  if (mode === "opt-out" && !granted) {
    return "Off because your browser sends Global Privacy Control.";
  }
  return mode === "opt-out" ? "On by default. Turn it off any time." : "Off until you turn it on.";
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
