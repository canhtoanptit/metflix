import type { ReactNode } from "react";
import { Toaster } from "./Toast.tsx";

export interface UiProviderProps {
  children: ReactNode;
  /** Render the toast region (default true). */
  toaster?: boolean;
}

/**
 * Root-level runtime of the design system: the toast region. Deliberately light: overlay and
 * tooltip code loads with the screens that use them.
 */
export function UiProvider({ children, toaster = true }: UiProviderProps) {
  return (
    <>
      {children}
      {toaster ? <Toaster /> : null}
    </>
  );
}
