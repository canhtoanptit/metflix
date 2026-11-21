import { Spinner } from "@webflix/ui";

/** Shown when a route takes longer than ~600 ms to resolve (slow chunk or loader). */
export function PagePending() {
  return (
    <div className="grid min-h-[60dvh] place-items-center">
      <Spinner size="lg" />
    </div>
  );
}
