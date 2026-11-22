/**
 * Start-up: read the console's settings, decide what this page load is (the issuer's callback,
 * a reload, a signed-out page), and mount the console only once a staff member is signed in and
 * the staff API has said who they are (`GET /me`). When the session ends the console unmounts
 * and its query cache is dropped: nothing a staff member looked at stays in memory.
 */
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { UiProvider } from "@webflix/ui";
import { useEffect, useMemo, useState } from "react";
import { ROLE_LABELS } from "../access/roles.ts";
import { StaffProvider } from "../access/staff.tsx";
import { createStaffApi, setStaffApi } from "../api/client.ts";
import { describeError, isUnreachable } from "../api/errors.ts";
import { queries } from "../api/queries.ts";
import { createStaffQueryClient } from "../api/query-client.ts";
import { type ConsoleRuntime, RuntimeContext, useAuthState } from "../auth/react.ts";
import { createStaffSession } from "../auth/session.ts";
import { ConfigError, loadRuntimeConfig } from "../config/runtime.ts";
import { memberSearch } from "../features/members/search-store.ts";
import { SignedOut, SigningIn, Unavailable } from "./AuthScreens.tsx";
import { createConsoleRouter } from "./router.tsx";

export function Boot() {
  const [runtime, setRuntime] = useState<ConsoleRuntime | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRuntimeConfig()
      .then((config) => {
        if (cancelled) return;
        const session = createStaffSession({ config });
        setStaffApi(createStaffApi(session));
        setRuntime({ config, session });
        void session.start({
          pathname: window.location.pathname,
          search: window.location.search,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setConfigError(error instanceof ConfigError ? error.message : "Unexpected error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (configError) {
    return (
      <UiProvider>
        <Unavailable
          title="The console isn't set up"
          detail={`${configError}. The platform serving the console provides its settings (config.json: the staff issuer and client id).`}
          onRetry={() => window.location.reload()}
        />
      </UiProvider>
    );
  }
  if (!runtime) return <SigningIn label="Starting the staff console…" />;
  return (
    <RuntimeContext value={runtime}>
      <UiProvider>
        <SessionGate runtime={runtime} />
      </UiProvider>
    </RuntimeContext>
  );
}

function SessionGate({ runtime }: { runtime: ConsoleRuntime }) {
  const { session, config } = runtime;
  const state = useAuthState(session);
  switch (state.status) {
    case "starting":
      return <SigningIn label="Starting the staff console…" />;
    case "redirecting":
      return <SigningIn label="Going to the staff sign-in service…" />;
    case "unavailable":
      return (
        <Unavailable
          title={
            state.kind === "storage"
              ? "This browser blocks signing in"
              : "Can't reach the staff sign-in service"
          }
          detail={state.detail}
          development={config.development}
          onRetry={() =>
            void session.signIn(`${window.location.pathname}${window.location.search}`)
          }
        />
      );
    case "signed-out":
      return (
        <SignedOut
          reason={state.reason}
          detail={state.detail}
          development={config.development}
          onSignIn={() => void session.signIn(state.returnTo)}
        />
      );
    case "signed-in":
      return <SignedInConsole runtime={runtime} />;
  }
}

function SignedInConsole({ runtime }: { runtime: ConsoleRuntime }) {
  // One cache and one router per signed-in session; unmounting drops both.
  const queryClient = useMemo(() => createStaffQueryClient(), []);
  useEffect(
    () => () => {
      queryClient.clear();
      memberSearch.clear();
    },
    [queryClient],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <WhoAmI runtime={runtime} />
    </QueryClientProvider>
  );
}

function WhoAmI({ runtime }: { runtime: ConsoleRuntime }) {
  const { session, config } = runtime;
  const me = useQuery(queries.me());
  const router = useMemo(() => createConsoleRouter(config.base), [config.base]);

  if (me.isPending) return <SigningIn label="Loading your staff profile…" />;
  if (me.isError) {
    const description = describeError(me.error);
    return (
      <Unavailable
        title={isUnreachable(me.error) ? "Can't reach the staff API" : description.title}
        detail={description.description}
        development={config.development}
        onRetry={() => void me.refetch()}
        onSignOut={() => session.signOut()}
      />
    );
  }
  if (me.data.roles.length === 0) {
    return (
      <Unavailable
        title="Your account has no staff role"
        detail={`You're signed in as ${me.data.name ?? me.data.email ?? "a staff account"}, but it has none of the console's roles (${Object.values(ROLE_LABELS).join(", ")}). Ask an admin to give you the role you need, then sign in again.`}
        development={config.development}
        onSignOut={() => session.signOut()}
      />
    );
  }
  return (
    <StaffProvider identity={me.data}>
      <RouterProvider router={router} />
    </StaffProvider>
  );
}
