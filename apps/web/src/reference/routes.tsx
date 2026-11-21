/**
 * Development-only routes (dev server and mock builds). In production builds `__WEBFLIX_DEVTOOLS__` is
 * false, so the route factory is never called and its lazily loaded page is never emitted.
 */
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { publicLayout } from "../app/router/layouts.tsx";

function createReferenceRoute() {
  return createRoute({
    getParentRoute: () => publicLayout,
    path: "/dev/reference",
    staticData: { title: "Design reference" },
    component: lazyRouteComponent(() => import("./ReferencePage.tsx"), "ReferencePage"),
  });
}

export const devRoutes = __WEBFLIX_DEVTOOLS__ ? ([createReferenceRoute()] as const) : ([] as const);
