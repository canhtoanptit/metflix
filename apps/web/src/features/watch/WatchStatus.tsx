import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Profile, TitleDetail } from "@webflix/contracts";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  Button,
  CreditCardIcon,
  DevicesIcon,
  ErrorReference,
  IconButton,
  type IconComponent,
  LockIcon,
  LogOutIcon,
  MonitorIcon,
  PauseIcon,
  ResponsiveImage,
  SearchIcon,
  WifiOffIcon,
} from "@webflix/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { describeError } from "../../app/query/errors.ts";
import { qk } from "../../app/query/keys.ts";
import { membershipOf, useSession } from "../../app/session/session.ts";
import { deletionTitle, useScheduledDeletion } from "../member/billing/deletion.tsx";
import { HrefLink } from "../member/billing/HrefLink.tsx";
import { describePaywall } from "../member/billing/paywall.ts";
import { possessive } from "../member/shared/format.ts";
import { standingOf } from "../member/shared/privileges.ts";
import type { WatchBlock } from "./lifecycle.ts";

function minutesAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

function maturityName(level: string): string {
  return level === "ALL" ? "All ages" : level;
}

export interface WatchStatusProps {
  block: WatchBlock;
  title: TitleDetail | undefined;
  profile: Profile;
  planName: string;
  /** The watch URL to come back to after signing in or choosing a profile. */
  returnTo: string;
  retrying: boolean;
  onRetry: () => void;
  onBack: () => void;
  onSignedOut: () => void;
  /** `page`: full screen with artwork; `overlay`: inside the player's blocking layer. */
  variant: "page" | "overlay";
}

interface Copy {
  icon: IconComponent;
  title: string;
  body: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  detail?: ReactNode;
  footnote?: ReactNode;
  /** Support reference, kept behind a "Details" disclosure. */
  reference?: string | null;
}

/**
 * Every way playback can be refused or stopped, each with a plain explanation and a way
 * forward. The same content renders as a full page (no session yet) or inside the player's
 * blocking layer (playback stopped mid-way, the picture paused behind it).
 */
export function WatchStatus(props: WatchStatusProps) {
  const { block, title, profile, planName, returnTo, retrying, onRetry, onBack } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queryClient = useQueryClient();
  // Read without assuming a session: the signed-out screen renders after the session ended.
  const session = useSession();
  const membershipPlanId = session.authenticated ? membershipOf(session).membership.planId : null;
  const deletion = useScheduledDeletion(block.kind === "membership");
  // Refused for the membership: the session learns the server's state too, so the profile gate
  // and Account say the same thing.
  useEffect(() => {
    if (block.kind === "membership") void queryClient.invalidateQueries({ queryKey: qk.session() });
  }, [block.kind, queryClient]);
  const name = title?.name ?? "This title";
  const backButton = (
    <Button variant="outline" size="lg" onClick={onBack}>
      Back to browse
    </Button>
  );
  const retryButton = (label: string) => (
    <Button variant="accent" size="lg" loading={retrying} onClick={onRetry}>
      {label}
    </Button>
  );
  const link = "focus-ring rounded-xs font-semibold text-fg underline underline-offset-2";

  let copy: Copy;
  switch (block.kind) {
    case "stream-limit": {
      const { limit, activeStreams } = block;
      copy = {
        icon: DevicesIcon,
        title: "Too many people are watching",
        body: (
          <>
            Your {planName} plan streams on {limit === 1 ? "one screen" : `${limit} screens`} at a
            time, and {limit === 1 ? "it's" : "they're all"} in use right now. Stop playing on
            {limit === 1 ? " that device" : " one of these devices"}, then try again.
          </>
        ),
        detail:
          activeStreams.length > 0 ? (
            <ul className="flex w-full flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-surface-1/80 text-start">
              {activeStreams.map((stream) => (
                <li key={stream.playbackSessionId} className="flex items-center gap-3 px-4 py-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-fg-muted">
                    <MonitorIcon size="sm" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate type-label text-fg">{stream.deviceLabel}</span>
                    <span className="truncate type-body-sm text-fg-muted">
                      {stream.titleName ? `Watching ${stream.titleName}` : "Watching"} · started{" "}
                      {minutesAgo(stream.startedAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null,
        primary: retryButton("Try again"),
        secondary: backButton,
        footnote: (
          <>
            A device that stops playing frees its screen within about a minute.
            {limit < 4 ? (
              <>
                {" "}
                Need more screens?{" "}
                <Link to="/account/membership/plan" className={link}>
                  Change plan
                </Link>
              </>
            ) : null}
          </>
        ),
      };
      break;
    }
    case "ended-elsewhere":
      copy = {
        icon: PauseIcon,
        title: "Playback stopped",
        body: "This stream was stopped from outside this device: the account's plan may have changed to fewer screens, or the connection dropped for too long. Your place is saved.",
        primary: retryButton("Resume watching"),
        secondary: backButton,
      };
      break;
    case "signed-out":
      copy = {
        icon: LogOutIcon,
        title: "You've been signed out",
        body: "This device was signed out of your account, either from another device or because the sign-in expired. Sign in again to keep watching.",
        primary: (
          <Button variant="accent" size="lg" onClick={props.onSignedOut}>
            Sign in again
          </Button>
        ),
      };
      break;
    // The server signed this device off the profile: its PIN was set or changed elsewhere.
    case "profile-required":
      copy = {
        icon: LockIcon,
        title: "This profile was locked on another device",
        body: `Someone added or changed ${possessive(profile.name)} PIN, so the profile closed here. Your place is saved: choose it again and enter the PIN to keep watching.`,
        primary: (
          <Button variant="accent" size="lg" asChild>
            <Link to="/profiles" search={{ redirect: returnTo }}>
              Choose a profile
            </Link>
          </Button>
        ),
      };
      break;
    case "membership": {
      // Milestone 2: the status the server named decides the way back (billing/paywall.ts).
      const status =
        block.membershipStatus ?? (block.subscriptionStatus === "ended" ? "canceled" : undefined);
      const paywall = describePaywall(status, { titleName: name, planId: membershipPlanId });
      const holder = standingOf(profile) === "unrestricted";
      // A scheduled deletion refuses a restart (or a first payment): keeping the account comes
      // first, so that is the way forward (a card change, for an unpaid one, still works).
      if (holder && deletion && status !== "suspended" && status !== "past_due") {
        copy = {
          icon: CreditCardIcon,
          title: deletionTitle(deletion.scheduledFor),
          body: `Your membership can't be restarted until you keep your account, so ${name} can't be played now. Keeping it is one step in Account › Privacy, and nothing has been charged.`,
          primary: (
            <Button variant="accent" size="lg" asChild>
              <Link to="/account/privacy">Go to Account › Privacy</Link>
            </Button>
          ),
          secondary: backButton,
        };
        break;
      }
      copy = {
        icon: CreditCardIcon,
        title: paywall.title,
        body: holder
          ? paywall.body
          : `${paywall.body} Membership is managed from a profile without parental controls: ask the account holder, or switch profile.`,
        primary: holder ? (
          <Button variant="accent" size="lg" asChild>
            <HrefLink href={paywall.action.href}>{paywall.action.label}</HrefLink>
          </Button>
        ) : (
          <Button variant="accent" size="lg" asChild>
            <Link to="/profiles" search={{ redirect: returnTo }}>
              Switch profile
            </Link>
          </Button>
        ),
        secondary: backButton,
      };
      break;
    }
    case "maturity":
      copy = {
        icon: LockIcon,
        title: `Not available on ${possessive(profile.name)} profile`,
        body: `${name} is rated ${maturityName(block.maturity)}. ${possessive(profile.name)} profile only shows titles rated ${maturityName(block.ceiling)} and under.`,
        primary: (
          <Button variant="accent" size="lg" asChild>
            <Link to="/profiles" search={{ redirect: returnTo }}>
              Switch profile
            </Link>
          </Button>
        ),
        secondary: backButton,
        footnote: "Maturity ratings can be changed in Manage profiles with the account password.",
      };
      break;
    case "not-found":
      copy = {
        icon: SearchIcon,
        title: "We can't find that title",
        body: "It may have left Webflix, or the link isn't quite right.",
        primary: (
          <Button variant="accent" size="lg" onClick={onBack}>
            Browse Webflix
          </Button>
        ),
      };
      break;
    case "unavailable":
      copy = {
        icon: AlertTriangleIcon,
        title: "This can't be played right now",
        body: `We're having trouble playing ${name}. Please try again in a little while.`,
        primary: retryButton("Try again"),
        secondary: backButton,
      };
      break;
    case "offline":
      copy = {
        icon: WifiOffIcon,
        title: "You're offline",
        body: "Check your Wi-Fi or mobile data. We'll carry on automatically as soon as you're connected.",
        primary: retryButton("Try again"),
        secondary: backButton,
      };
      break;
    case "error": {
      const described = describeError(block.error);
      copy = {
        icon: AlertTriangleIcon,
        title: "Something went wrong",
        body: described.description,
        primary: retryButton("Try again"),
        secondary: backButton,
        reference: described.reference,
      };
      break;
    }
  }

  // Announce the new situation and start keyboard users on it (in the player, the blocking
  // layer focuses the primary action itself).
  useEffect(() => {
    if (props.variant === "page") headingRef.current?.focus({ preventScroll: true });
  }, [props.variant]);

  const Heading = props.variant === "page" ? "h1" : "h2";
  const content = (
    <div className="flex w-full max-w-dialog-md flex-col items-center gap-5 text-center">
      <span className="grid size-16 place-items-center rounded-full bg-surface-3/80 text-fg">
        <copy.icon size="xl" />
      </span>
      <Heading
        ref={headingRef}
        tabIndex={-1}
        id="watch-status-title"
        className="type-headline text-fg outline-none"
      >
        {copy.title}
      </Heading>
      <p className="type-body-lg text-fg-muted">{copy.body}</p>
      {copy.detail}
      {/* Primary first in the DOM (it takes focus in the player's overlay), right on desktop. */}
      <div className="mt-2 flex w-full flex-col gap-3 sm:w-auto sm:flex-row-reverse sm:justify-center">
        {copy.primary}
        {copy.secondary}
      </div>
      {copy.footnote ? <p className="type-body-sm text-fg-subtle">{copy.footnote}</p> : null}
      {copy.reference ? <ErrorReference reference={copy.reference} /> : null}
    </div>
  );

  // The same full-viewport composition on its own page and inside the player's blocking layer
  // (which fills the whole player, centres and scrolls its content, and lets an absolutely
  // positioned child paint full-bleed behind it): the title's backdrop, dimmed, behind the
  // message, with Back in the top corner.
  const backdrop = title ? (
    <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden bg-black">
      <ResponsiveImage
        image={title.images.backdrop}
        alt=""
        fill
        sizes="100vw"
        className="absolute inset-0 opacity-30"
      />
      <div className="absolute inset-0 bg-canvas/60" />
      <div className="absolute inset-0 scrim-bottom" />
    </div>
  ) : (
    <div aria-hidden className="absolute inset-0 -z-10 bg-canvas" />
  );
  const back = (
    <IconButton
      label="Back to browse"
      icon={ArrowLeftIcon}
      variant="glass"
      size="lg"
      onClick={onBack}
    />
  );

  const testId = `watch-status-${block.kind}`;
  if (props.variant === "overlay") {
    // Children of the player's layer. Back comes after the message in the DOM (it sits in the
    // top corner): the layer focuses the first control, which must be the primary action.
    return (
      <>
        {backdrop}
        <div className="flex w-full justify-center py-nav" data-testid={testId}>
          {content}
        </div>
        <div className="absolute start-0 top-0 flex h-nav items-center px-gutter">{back}</div>
      </>
    );
  }

  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-black" data-testid={testId}>
      {backdrop}
      <header className="flex h-nav shrink-0 items-center px-gutter">{back}</header>
      <main id="main" className="flex flex-1 items-center justify-center px-gutter pb-nav">
        {content}
      </main>
    </div>
  );
}
