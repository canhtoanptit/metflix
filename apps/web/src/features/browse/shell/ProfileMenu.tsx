import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Profile } from "@webflix/contracts";
import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EditIcon,
  HistoryIcon,
  KidsIcon,
  LockIcon,
  LogOutIcon,
  toast,
  UserIcon,
} from "@webflix/ui";
import { useEffect, useRef } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { useApplySession } from "../../../app/session/session.ts";
import { useBrowseProfile, useBrowseSession } from "../common/session.ts";
import { type HandoverProps, PROFILE_TRIGGER_CLASS, ProfileTriggerContent } from "./menus.tsx";

/**
 * The avatar menu: switch straight to another profile (a locked one goes through the
 * "Who's watching?" gate for its PIN), manage profiles, account, sign out. Kids profiles get
 * "Exit Kids" only: account settings are for grown-ups.
 */
export function ProfileMenu({
  compact = false,
  defaultOpen = false,
  autoFocus = false,
}: { compact?: boolean } & HandoverProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus && !defaultOpen) trigger.current?.focus();
  }, []);
  const session = useBrowseSession();
  const profile = useBrowseProfile();
  const others = session.profiles.filter((candidate) => candidate.id !== profile.id);
  const applySession = useApplySession();
  const navigate = useNavigate();

  const switchProfile = useMutation({
    mutationFn: (next: Profile) => api().selectProfile({ body: { profileId: next.id } }),
    onSuccess: async (next) => {
      await applySession(next);
      await navigate({ to: "/browse" });
    },
    onError: (error) => {
      const described = describeError(error);
      toast.error("Couldn't switch profile", { description: described.description });
    },
  });

  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger
        ref={trigger}
        className={PROFILE_TRIGGER_CLASS}
        aria-label={`Profile menu for ${profile.name}`}
      >
        <ProfileTriggerContent compact={compact} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Signed in as {profile.name}</DropdownMenuLabel>
        {profile.isKids ? (
          <DropdownMenuItem icon={KidsIcon} asChild>
            <Link to="/profiles">Exit Kids</Link>
          </DropdownMenuItem>
        ) : (
          <>
            {others.map((other) =>
              other.isLocked ? (
                <DropdownMenuItem
                  key={other.id}
                  asChild
                  leading={
                    <Avatar src={other.avatar.imageUrl} name={other.name} size="xs" decorative />
                  }
                >
                  <Link to="/profiles" search={{ redirect: "/browse" }}>
                    <span className="flex-1">{other.name}</span>
                    <LockIcon size="sm" label="Locked" className="text-fg-subtle" />
                  </Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  key={other.id}
                  leading={
                    <Avatar src={other.avatar.imageUrl} name={other.name} size="xs" decorative />
                  }
                  disabled={switchProfile.isPending}
                  onSelect={() => switchProfile.mutate(other)}
                >
                  <span className="flex-1">{other.name}</span>
                  {other.isKids ? (
                    <KidsIcon size="sm" label="Kids" className="text-fg-subtle" />
                  ) : null}
                </DropdownMenuItem>
              ),
            )}
            <DropdownMenuItem icon={EditIcon} asChild>
              <Link to="/profiles/manage">Manage profiles</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={UserIcon} asChild>
              <Link to="/account">Account</Link>
            </DropdownMenuItem>
            <DropdownMenuItem icon={HistoryIcon} asChild>
              <Link to="/account/activity">Viewing activity</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={LogOutIcon} asChild>
              <Link to="/logout">Sign out of Webflix</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
