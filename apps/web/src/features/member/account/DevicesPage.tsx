import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { DeviceSession, DeviceSessionList } from "@webflix/contracts";
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  type IconComponent,
  LogOutIcon,
  MonitorIcon,
  Skeleton,
  SmartphoneIcon,
  TabletIcon,
  TvIcon,
  toast,
} from "@webflix/ui";
import { useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { optimisticUpdate } from "../../../app/query/optimistic.ts";
import { queries } from "../../../app/query/queries.ts";
import { sessionCache } from "../../../app/session/session.ts";
import { formatRelativeTime, formatShortDate } from "../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../shared/privileges.ts";
import { AccountHeading, AccountSection } from "./AccountLayout.tsx";

const DEVICE_ICONS: Record<DeviceSession["deviceType"], IconComponent> = {
  desktop: MonitorIcon,
  mobile: SmartphoneIcon,
  tablet: TabletIcon,
  tv: TvIcon,
  unknown: MonitorIcon,
};

/**
 * Signed-in devices. Signing out another device ends its session at once and frees its stream;
 * a player there stops at its next heartbeat, so within about half a minute (the copy says so,
 * no more). Signing out this one goes through the normal sign-out. "Sign out of all devices"
 * includes this one. The shared demo account can only sign out this device.
 */
export function AccountDevicesPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const demo = useIsDemoAccount();
  const devices = useQuery(queries.devices());
  const [revoking, setRevoking] = useState<DeviceSession | null>(null);
  const [everywhere, setEverywhere] = useState(false);

  const revoke = useMutation({
    mutationFn: (device: DeviceSession) => api().revokeDevice({ params: { id: device.id } }),
    meta: { silent: true },
    onMutate: async (device) => {
      setRevoking(null);
      return optimisticUpdate(queryClient, qk.account.devices(), (data) => {
        const list = data as DeviceSessionList;
        return { items: list.items.filter((item) => item.id !== device.id) };
      });
    },
    onError: (error, device, rollback) => {
      rollback?.();
      toast.error(`Couldn't sign out ${device.label}`, {
        description: describeMemberError(error).description,
      });
    },
    onSuccess: (_data, device) => {
      toast.success(`${device.label} was signed out`, {
        description: "Anything playing there stops within about half a minute.",
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.account.devices() }),
  });

  const signOutAll = useMutation({
    mutationFn: () => api().logoutAll(),
    meta: { silent: true },
    onSuccess: async () => {
      sessionCache.signOut(queryClient);
      await router.invalidate();
      toast.success("Signed out of all devices");
      await navigate({ to: "/login", search: {}, replace: true });
    },
  });

  const items = devices.data?.items ?? [];
  const sorted = [...items].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt),
  );

  return (
    <>
      <AccountHeading
        title="Devices"
        description={
          demo
            ? "Browsers and devices signed in to the demo account. Other devices can't be signed out from the demo account."
            : "Browsers and devices signed in to your account. Sign out any you don't recognize, then change your password."
        }
      />
      <AccountSection title="Signed-in devices">
        {devices.isPending ? (
          <div className="flex flex-col gap-4" aria-busy="true">
            {[0, 1, 2].map((key) => (
              <div key={key} className="flex items-center gap-4">
                <Skeleton className="size-11" radius="full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
              </div>
            ))}
          </div>
        ) : devices.isError ? (
          <ErrorState
            title="We couldn't load your devices"
            description={describeError(devices.error).description}
            action={
              <Button variant="primary" onClick={() => void devices.refetch()}>
                Try again
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col divide-y divide-line-subtle">
            {sorted.map((device) => {
              const Icon = DEVICE_ICONS[device.deviceType];
              return (
                <li
                  key={device.id}
                  className="flex flex-wrap items-center gap-4 py-4 first:pt-0 last:pb-0"
                >
                  <span className="grid size-11 shrink-0 place-items-center rounded-full bg-surface-3 text-fg-muted">
                    <Icon size="md" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 type-label text-fg">
                      {device.label}
                      {device.current ? (
                        <Badge tone="positive" size="sm">
                          This device
                        </Badge>
                      ) : null}
                    </span>
                    <span className="type-body-sm text-fg-muted">
                      {device.current
                        ? `Active now · signed in ${formatShortDate(device.createdAt)}`
                        : `Last active ${formatRelativeTime(device.lastSeenAt)} · signed in ${formatShortDate(device.createdAt)}`}
                    </span>
                  </div>
                  {device.current || !demo ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        device.current ? navigate({ to: "/logout" }) : setRevoking(device)
                      }
                      aria-label={
                        device.current ? "Sign out of this device" : `Sign out ${device.label}`
                      }
                    >
                      Sign out
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </AccountSection>

      {demo ? null : (
        <AccountSection
          title="Sign out everywhere"
          description="Signs out every device, including this one. Anything playing on another device stops within about half a minute. Use it if you've shared your password or lost a device."
        >
          <div>
            <Button variant="outline" icon={LogOutIcon} onClick={() => setEverywhere(true)}>
              Sign out of all devices
            </Button>
          </div>
        </AccountSection>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Sign out ${revoking?.label ?? "this device"}?`}
        description="It will need your email and password to get back in. Anything playing on it stops within about half a minute."
        confirmLabel="Sign out device"
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking);
        }}
      />
      <ConfirmDialog
        open={everywhere}
        onOpenChange={setEverywhere}
        title="Sign out of all devices?"
        description={
          <>
            Every device signed in to this account, including this one, will be signed out. Anything
            playing on another device stops within about half a minute. You'll need your password to
            sign back in.
            {signOutAll.isError ? (
              <span className="mt-3 block text-danger" role="alert">
                {describeMemberError(signOutAll.error).description}
              </span>
            ) : null}
          </>
        }
        confirmLabel="Sign out everywhere"
        loading={signOutAll.isPending}
        onConfirm={() => signOutAll.mutate()}
      />
    </>
  );
}
