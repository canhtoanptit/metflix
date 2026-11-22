import type { StaffIdentity, StaffRole } from "@webflix/contracts";
import { createContext, type ReactNode, useContext } from "react";
import { canCall, hasRole } from "./roles.ts";

interface StaffValue {
  identity: StaffIdentity;
  roles: readonly StaffRole[];
  has: (role: StaffRole) => boolean;
  canCall: (route: Parameters<typeof canCall>[1]) => boolean;
}

const StaffContext = createContext<StaffValue | null>(null);

/** Who is signed in, as the staff API's `GET /me` reports it (never read from a token). */
export function StaffProvider({
  identity,
  children,
}: {
  identity: StaffIdentity;
  children: ReactNode;
}) {
  const value: StaffValue = {
    identity,
    roles: identity.roles,
    has: (role) => hasRole(identity.roles, role),
    canCall: (route) => canCall(identity.roles, route),
  };
  return <StaffContext value={value}>{children}</StaffContext>;
}

export function useStaff(): StaffValue {
  const value = useContext(StaffContext);
  if (!value) throw new Error("useStaff outside StaffProvider");
  return value;
}
