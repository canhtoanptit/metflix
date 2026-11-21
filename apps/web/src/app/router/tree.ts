import { browseRoutes } from "../../features/browse/routes.tsx";
import { memberRoutes } from "../../features/member/routes.tsx";
import { watchRoutes } from "../../features/watch/routes.tsx";
import { devRoutes } from "../../reference/routes.tsx";
import { accountLayout, guestLayout, profileLayout, publicLayout } from "./layouts.tsx";
import { rootRoute } from "./root.tsx";

/**
 * The complete route tree. Features own their routes (`features/<area>/routes.tsx`) and export
 * them grouped by access level; this file only plugs the groups into the guard layouts, so adding
 * or changing a screen never touches it.
 */
export const routeTree = rootRoute.addChildren([
  publicLayout.addChildren([...memberRoutes.public, ...devRoutes]),
  guestLayout.addChildren([...memberRoutes.guest]),
  accountLayout.addChildren([...memberRoutes.account]),
  profileLayout.addChildren([
    ...browseRoutes.profile,
    ...memberRoutes.profile,
    ...watchRoutes.profile,
  ]),
]);
