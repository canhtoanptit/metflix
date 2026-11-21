/**
 * @webflix/http: the HTTP application. `createApp(container)` serves the whole contract
 * (route table), media delivery and ops endpoints on any runtime; the primitives below
 * (route binding, problem documents, metrics) are exported for entrypoints and tests.
 */
export { createApp } from "./app.ts";
export type {
  AppContainer,
  AppEnv,
  AppVariables,
  DocsAssets,
  ReadinessCheck,
} from "./container.ts";
export {
  type Counter,
  createMetricsRegistry,
  DEFAULT_LATENCY_BUCKETS,
  type Gauge,
  type GaugeSample,
  type Histogram,
  type Labels,
  METRICS_CONTENT_TYPE,
  type MetricsRegistry,
} from "./metrics.ts";
export { DEFAULT_DOCS_SCRIPT_URL, docsContentSecurityPolicy } from "./ops.ts";
export {
  type ProblemHandlerOptions,
  problemContextResponse,
  problemErrorHandler,
  problemNotFoundHandler,
  problemResponse,
} from "./problem.ts";
export { redactPath } from "./redact.ts";
export {
  type BindOptions,
  bindRoute,
  bindRoutes,
  type RouteHandler,
  type RouteHandlers,
  requireClientHeader,
} from "./routing.ts";
export { defaultClientIp } from "./session.ts";
