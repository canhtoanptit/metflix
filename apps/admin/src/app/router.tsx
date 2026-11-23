/**
 * The console's routes, under its base path. Each screen names the role it needs; a link to a
 * screen the staff member's roles do not open (typed or pasted) shows "no access" and calls
 * nothing. Screens load as their own chunks.
 *
 * URLs carry identifiers only (account ids, experiment keys, audit filters): never an email
 * address or a name. The member search keeps its query in memory for that reason.
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import type { StaffRole } from "@webflix/contracts";
import { AUDIT_OUTCOMES, type AuditOutcome } from "@webflix/contracts";
import { type ComponentType, lazy, type ReactElement, Suspense } from "react";
import { useStaff } from "../access/staff.tsx";
import { LoadingPage, NoPermission } from "../components/states.tsx";
import { AUDIT_SHOW, type AuditShow } from "../features/operations/audit-filter.ts";
import { NotFound, Shell } from "./Shell.tsx";

/**
 * A screen behind a role: its code loads only for someone whose roles open it (React.lazy, so the
 * check runs before the chunk is fetched), and anyone else gets "no access" without a request.
 */
function guarded(
  role: StaffRole,
  what: string,
  load: () => Promise<{ default: ComponentType }>,
): () => ReactElement {
  const Screen = lazy(load);
  function Guarded(): ReactElement {
    const staff = useStaff();
    if (!staff.has(role)) return <NoPermission role={role} what={what} roles={staff.roles} />;
    return (
      <Suspense fallback={<LoadingPage />}>
        <Screen />
      </Suspense>
    );
  }
  return Guarded;
}

/** `import()` of a module's named export, as React.lazy wants it. */
function named<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return () => load().then((module) => ({ default: module[name] as ComponentType }));
}

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const home = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("../features/home/HomePage.tsx"), "HomePage"),
});

const members = createRoute({
  getParentRoute: () => rootRoute,
  path: "/members",
  component: guarded(
    "support",
    "Members",
    named(() => import("../features/members/MemberSearchPage.tsx"), "MemberSearchPage"),
  ),
});

const member = createRoute({
  getParentRoute: () => rootRoute,
  path: "/members/$accountId",
  component: guarded(
    "support",
    "Members",
    named(() => import("../features/members/MemberPage.tsx"), "MemberPage"),
  ),
});

const plans = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans",
  component: guarded(
    "billing",
    "Plans & prices",
    named(() => import("../features/plans/PlansPage.tsx"), "PlansPage"),
  ),
});

const content = createRoute({
  getParentRoute: () => rootRoute,
  path: "/content",
  beforeLoad: () => {
    throw redirect({ to: "/content/billboards" });
  },
});

const billboards = createRoute({
  getParentRoute: () => rootRoute,
  path: "/content/billboards",
  component: guarded(
    "content",
    "Content",
    named(() => import("../features/content/BillboardsPage.tsx"), "BillboardsPage"),
  ),
});

const collections = createRoute({
  getParentRoute: () => rootRoute,
  path: "/content/collections",
  component: guarded(
    "content",
    "Content",
    named(() => import("../features/content/CollectionsPage.tsx"), "CollectionsPage"),
  ),
});

const collectionNew = createRoute({
  getParentRoute: () => rootRoute,
  path: "/content/collections/new",
  component: guarded(
    "content",
    "Content",
    named(() => import("../features/content/CollectionEditorPage.tsx"), "NewCollectionPage"),
  ),
});

const collectionEdit = createRoute({
  getParentRoute: () => rootRoute,
  path: "/content/collections/$id",
  component: guarded(
    "content",
    "Content",
    named(() => import("../features/content/CollectionEditorPage.tsx"), "EditCollectionPage"),
  ),
});

const availability = createRoute({
  getParentRoute: () => rootRoute,
  path: "/content/availability",
  component: guarded(
    "content",
    "Content",
    named(() => import("../features/content/AvailabilityPage.tsx"), "AvailabilityPage"),
  ),
});

const experiments = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments",
  component: guarded(
    "experiments",
    "Experiments",
    named(() => import("../features/experiments/ExperimentsPage.tsx"), "ExperimentsPage"),
  ),
});

const experimentNew = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments/new",
  component: guarded(
    "experiments",
    "Experiments",
    named(() => import("../features/experiments/ExperimentFormPage.tsx"), "NewExperimentPage"),
  ),
});

const experiment = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments/$key",
  component: guarded(
    "experiments",
    "Experiments",
    named(() => import("../features/experiments/ExperimentPage.tsx"), "ExperimentPage"),
  ),
});

const experimentEdit = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments/$key/edit",
  component: guarded(
    "experiments",
    "Experiments",
    named(() => import("../features/experiments/ExperimentFormPage.tsx"), "EditExperimentPage"),
  ),
});

const operations = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations",
  beforeLoad: () => {
    throw redirect({ to: "/operations/health" });
  },
});

const health = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations/health",
  component: guarded(
    "admin",
    "Operations",
    named(() => import("../features/operations/HealthPage.tsx"), "HealthPage"),
  ),
});

const deadLetters = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations/dead-letters",
  component: guarded(
    "admin",
    "Operations",
    named(() => import("../features/operations/DeadLettersPage.tsx"), "DeadLettersPage"),
  ),
});

const recommendations = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations/recommendations",
  component: guarded(
    "admin",
    "Operations",
    named(() => import("../features/operations/RecommendationsPage.tsx"), "RecommendationsPage"),
  ),
});

const privacyJobs = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations/privacy",
  component: guarded(
    "admin",
    "Operations",
    named(() => import("../features/operations/PrivacyJobsPage.tsx"), "PrivacyJobsPage"),
  ),
});

export interface AuditSearch {
  targetType?: string;
  targetId?: string;
  actorId?: string;
  outcome?: AuditOutcome;
  /** The entries of the request sent with this `X-Request-Id` (an action whose outcome was unclear). */
  requestId?: string;
  /**
   * Which entries: `actions` (changes only), `all` (views of member data too) or `views`. Absent:
   * actions, or everything when looking for a request's entry.
   */
  show?: AuditShow;
}

const text = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === "string" && pattern.test(value) ? value : undefined;

export function parseAuditSearch(search: Record<string, unknown>): AuditSearch {
  const outcome = (AUDIT_OUTCOMES as readonly string[]).includes(String(search.outcome))
    ? (search.outcome as AuditOutcome)
    : undefined;
  const parsed: AuditSearch = {
    targetType: text(search.targetType, /^[a-z][a-z_-]{0,31}$/),
    targetId: text(search.targetId, /^[^\s]{1,255}$/),
    actorId: text(search.actorId, /^[^\s]{1,255}$/),
    outcome,
    requestId: text(search.requestId, /^[A-Za-z0-9._-]{1,64}$/),
    show: (AUDIT_SHOW as readonly string[]).includes(String(search.show))
      ? (search.show as AuditShow)
      : undefined,
  };
  // The router merges validated values over the raw URL: overwrite, never omit, a rejected one.
  return parsed;
}

export const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations/audit",
  validateSearch: parseAuditSearch,
  component: guarded(
    "admin",
    "the audit log",
    named(() => import("../features/operations/AuditPage.tsx"), "AuditPage"),
  ),
});

export interface ActivitySearch {
  outcome?: AuditOutcome;
  requestId?: string;
  show?: AuditShow;
}

export function parseActivitySearch(search: Record<string, unknown>): ActivitySearch {
  const { outcome, requestId, show } = parseAuditSearch(search);
  return { outcome, requestId, show };
}

export const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  validateSearch: parseActivitySearch,
  component: lazyRouteComponent(
    () => import("../features/operations/MyActionsPage.tsx"),
    "MyActionsPage",
  ),
});

const routeTree = rootRoute.addChildren([
  activityRoute,
  home,
  members,
  member,
  plans,
  content,
  billboards,
  collections,
  collectionNew,
  collectionEdit,
  availability,
  experiments,
  experimentNew,
  experiment,
  experimentEdit,
  operations,
  health,
  deadLetters,
  recommendations,
  privacyJobs,
  auditRoute,
]);

export function createConsoleRouter(base: string) {
  return createRouter({
    routeTree,
    basepath: base.replace(/\/$/, "") || "/",
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
  });
}

export type ConsoleRouter = ReturnType<typeof createConsoleRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: ConsoleRouter;
  }
}
