import type { AppContainer } from "../container.ts";
import type { AreaHandlers } from "./types.ts";

/**
 * The experiments area's member routes: none yet (assignments travel in `GET /session`, the
 * staff routes are the admin area's). A route this area adds to the contract with
 * `area: "experiments"` must be handled here.
 */
export function createExperimentsHandlers(_container: AppContainer): AreaHandlers<"experiments"> {
  return {};
}
