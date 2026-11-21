import * as z from "zod";
import { MATURITY_LEVELS } from "./constants.ts";

/** Ordered: ALL < 7+ < 13+ < 16+ < 18+ (compare with the `@webflix/core` maturity helpers). */
export const MaturityLevel = z.enum(MATURITY_LEVELS).meta({
  id: "MaturityLevel",
  description: "Maturity rating. Ordered: ALL < 7+ < 13+ < 16+ < 18+.",
});
export type MaturityLevel = z.output<typeof MaturityLevel>;
