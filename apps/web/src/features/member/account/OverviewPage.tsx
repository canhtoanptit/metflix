import { Link } from "@tanstack/react-router";
import type { AccountDetails } from "@webflix/contracts";
import {
  Avatar,
  Badge,
  Button,
  ChevronRightIcon,
  EmailText,
  ErrorState,
  KidsIcon,
  LockIcon,
  MailIcon,
} from "@webflix/ui";
import { describeError } from "../../../app/query/errors.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { isUnfinishedSignup } from "../billing/membership.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatLongDate } from "../shared/format.ts";
import { useIsDemoAccount } from "../shared/privileges.ts";
import { AccountHeading, AccountSection } from "./AccountLayout.tsx";
import {
  MembershipAlert,
  MembershipBadge,
  MembershipFacts,
  MembershipSkeleton,
} from "./MembershipSummary.tsx";
import { useAccountDetails } from "./membership.ts";

/**
 * Account overview: membership and billing, sign-in details, devices and profiles at a glance.
 * The shared demo account says once here what stays fixed, and offers no way to change it.
 */
export function AccountOverviewPage() {
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const details = useAccountDetails();
  // No profiles yet (sign-up not finished): profiles and their activity come once it is.
  const unfinished = isUnfinishedSignup(session);

  return (
    <>
      <AccountHeading
        title="Account"
        description={
          <>
            Member since {formatLongDate(session.account.createdAt)} ·{" "}
            <EmailText>{session.account.email}</EmailText>
          </>
        }
      />
      {demo ? (
        <FormAlert tone="info" title="This is the shared demo account">
          Everyone who tries Webflix uses it, so its sign-in details, membership and profiles can't
          be changed. Playback settings and viewing activity are yours to change.
        </FormAlert>
      ) : null}
      {details.isPending ? (
        <MembershipSkeleton />
      ) : details.isError ? (
        <ErrorState
          layout="inline"
          title="We couldn't load your membership"
          description={describeError(details.error).description}
          action={
            <Button variant="accent" onClick={() => void details.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <MembershipPanel details={details.data} />
      )}

      <AccountSection
        title="Security"
        description="How you sign in to Webflix."
        action={demo ? null : <SectionLink to="/account/security">Update</SectionLink>}
      >
        {session.account.emailVerified === false && !demo ? (
          <FormAlert
            tone="accent"
            icon={MailIcon}
            title="Verify your email address"
            action={
              <Link
                to="/account/security"
                className="focus-ring rounded-xs type-label text-fg underline underline-offset-2"
              >
                Verify it in Account › Security
              </Link>
            }
          >
            A verified address lets you reset your password, and lets Google or Apple sign you in
            when they use the same address.
          </FormAlert>
        ) : null}
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="type-caption text-fg-subtle">Email</dt>
            <dd className="type-body text-fg">
              <EmailText>{session.account.email}</EmailText>
            </dd>
          </div>
          <div>
            <dt className="type-caption text-fg-subtle">Password</dt>
            {session.account.hasPassword === false ? (
              <dd className="type-body text-fg">Not set: you sign in with Google or Apple</dd>
            ) : (
              <dd className="type-body text-fg">
                <span aria-hidden>••••••••••</span>
                <span className="sr-only">Hidden</span>
              </dd>
            )}
          </div>
        </dl>
      </AccountSection>

      <AccountSection
        title="Devices"
        description="Where you're signed in. Sign out any device remotely."
        action={<SectionLink to="/account/devices">Manage devices</SectionLink>}
      />

      <AccountSection
        title="Privacy"
        description="Choose how Webflix uses your activity, get a copy of your data, or delete your account."
        action={<SectionLink to="/account/privacy">Manage privacy</SectionLink>}
      />

      {unfinished ? null : (
        <>
          <AccountSection
            title="Profiles"
            description={`${session.profiles.length} of 5 profiles in use.`}
            action={<SectionLink to="/profiles/manage">Manage profiles</SectionLink>}
          >
            <ul className="flex flex-col divide-y divide-line-subtle">
              {session.profiles.map((profile) => (
                <li key={profile.id}>
                  <Link
                    to="/profiles/$profileId/edit"
                    params={{ profileId: profile.id }}
                    className="focus-ring-inset group flex items-center gap-4 rounded-sm py-3"
                  >
                    <Avatar
                      src={profile.avatar.imageUrl}
                      name={profile.name}
                      size="md"
                      decorative
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2 type-label text-fg">
                        {profile.name}
                        {profile.id === session.activeProfile?.id ? (
                          <Badge tone="outline" size="sm">
                            This profile
                          </Badge>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2 type-body-sm text-fg-muted">
                        {profile.isKids ? (
                          <>
                            <KidsIcon size="xs" /> Kids ·{" "}
                          </>
                        ) : null}
                        Maturity{" "}
                        {profile.maturityCeiling === "ALL" ? "All ages" : profile.maturityCeiling}
                        {profile.isLocked ? (
                          <>
                            {" "}
                            · <LockIcon size="xs" /> Locked
                          </>
                        ) : null}
                      </span>
                    </span>
                    <ChevronRightIcon
                      size="md"
                      className="text-fg-subtle transition-transform duration-fast group-hover:translate-x-0.5"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </AccountSection>

          <AccountSection
            title="Viewing activity"
            description="Titles a profile has watched. Remove anything you'd rather it forgot."
            action={<SectionLink to="/account/activity">View activity</SectionLink>}
          />
        </>
      )}
    </>
  );
}

function SectionLink({
  to,
  children,
}: {
  to:
    | "/account/security"
    | "/account/devices"
    | "/profiles/manage"
    | "/account/activity"
    | "/account/membership"
    | "/account/privacy";
  children: string;
}) {
  return (
    <Button variant="outline" size="sm" iconAfter={ChevronRightIcon} asChild>
      <Link to={to}>{children}</Link>
    </Button>
  );
}

/**
 * The membership at a glance: its status, what needs attention (with the one action that fixes
 * it), plan, dates and card. Changing anything happens on the Membership page.
 */
function MembershipPanel({ details }: { details: AccountDetails }) {
  const demo = useIsDemoAccount();
  return (
    <AccountSection title="Membership" action={<MembershipBadge details={details} />}>
      <MembershipAlert details={details} readOnly={demo} />
      <MembershipFacts details={details} />
      <div className="flex flex-wrap gap-3 border-t border-line-subtle pt-5">
        <SectionLink to="/account/membership">Manage membership</SectionLink>
      </div>
    </AccountSection>
  );
}
