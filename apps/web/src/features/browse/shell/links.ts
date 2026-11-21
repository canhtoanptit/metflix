import { BROWSE_NAV } from "../routes.tsx";

/** Primary destinations in navigation order (views of Home, then My List). */
export const PRIMARY_LINKS = [
  ...BROWSE_NAV,
  { view: null, to: "/my-list", label: "My List" },
] as const;
