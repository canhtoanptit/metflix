import { createContext, useContext, useSyncExternalStore } from "react";
import type { RuntimeConfig } from "../config/runtime.ts";
import type { AuthState, StaffSession } from "./session.ts";

export interface ConsoleRuntime {
  config: RuntimeConfig;
  session: StaffSession;
}

export const RuntimeContext = createContext<ConsoleRuntime | null>(null);

export function useRuntime(): ConsoleRuntime {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("useRuntime outside RuntimeContext");
  return value;
}

export function useAuthState(session: StaffSession): AuthState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}
