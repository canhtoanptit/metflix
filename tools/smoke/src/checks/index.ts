import type { CheckDefinition } from "../types.ts";
import { browseChecks } from "./browse.ts";
import { consistencyChecks } from "./consistency.ts";
import { hardeningChecks } from "./hardening.ts";
import { identityChecks, signinFloodCheck } from "./identity.ts";
import { libraryChecks } from "./library.ts";
import { mediaChecks } from "./media.ts";
import { opsChecks } from "./ops.ts";
import { pipelineChecks } from "./pipeline.ts";
import { planChecks } from "./plans.ts";
import { playbackChecks } from "./playback.ts";
import { privilegeChecks } from "./privileges.ts";
import { profileChecks } from "./profiles.ts";
import { rateLimitChecks } from "./ratelimit.ts";

/** Every check, in report order. Ids are unique and stable (used by --only/--skip/--expect-fail). */
export const allChecks: readonly CheckDefinition[] = [
  ...opsChecks,
  ...identityChecks,
  ...profileChecks,
  ...privilegeChecks,
  ...browseChecks,
  ...libraryChecks,
  ...mediaChecks,
  ...playbackChecks,
  ...planChecks,
  ...consistencyChecks,
  ...rateLimitChecks,
  ...pipelineChecks,
  ...hardeningChecks,
  signinFloodCheck,
];
