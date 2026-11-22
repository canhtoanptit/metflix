import type { AdminRoutes, AreaRoutes, RouteArea, Routes } from "@webflix/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../container.ts";
import type { RouteHandlers } from "../routing.ts";

/**
 * The handlers of one area: exactly the routes of `routes` whose `area` is `A` (a missing or
 * extra handler is a compile error in that area's file).
 */
export type AreaHandlers<A extends RouteArea> = RouteHandlers<AreaRoutes<Routes, A>, AppEnv>;

/** The staff API's handlers (the admin area). */
export type AdminHandlers = RouteHandlers<AdminRoutes, AppEnv>;

export type AppContext = Context<AppEnv>;
