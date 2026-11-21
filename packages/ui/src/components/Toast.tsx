import { lazy, Suspense, useSyncExternalStore } from "react";
import { getToasts, subscribeToasts } from "./toast-store.ts";

export { type ToastOptions, type ToastTone, toast } from "./toast-store.ts";

const ToastViewport = lazy(() =>
  import("./ToastViewport.tsx").then((module) => ({ default: module.ToastViewport })),
);

/**
 * Mount once near the root (`UiProvider` does). Loads the toast UI only when the first toast is
 * shown, so it costs nothing at startup.
 */
export function Toaster() {
  const hasToasts = useSyncExternalStore(
    subscribeToasts,
    () => getToasts().length > 0,
    () => false,
  );
  return hasToasts ? (
    <Suspense fallback={null}>
      <ToastViewport />
    </Suspense>
  ) : null;
}
