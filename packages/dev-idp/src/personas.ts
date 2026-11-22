/**
 * Personas: the accounts the development issuer can assert, and how a persona becomes the claims
 * of one sign-in.
 */
import type { DevIdpPersona, JsonValue, PersonaRoles } from "./config.ts";
import { sha256 } from "./encoding.ts";
import type { Profile, ProfileName } from "./profiles.ts";

/** Must equal `DEMO_ACCOUNT_EMAIL` in `@webflix/contracts` (a test keeps them in step). */
export const DEMO_ACCOUNT_EMAIL = "demo@webflix.dev";

/** The staff roles of the admin console (docs/BLUEPRINT-M2.md §8.3). */
export const STAFF_ROLES = ["support", "billing", "content", "experiments", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** The client whose `resource_access` entry carries the staff roles. */
export const STAFF_ROLE_CLIENT = "webflix-admin";

/** Keycloak puts these realm roles on every user; a role mapping must ignore them. */
const KEYCLOAK_DEFAULT_REALM_ROLES = [
  "default-roles-webflix",
  "offline_access",
  "uma_authorization",
];
/** And these client roles of its built-in `account` client. */
const KEYCLOAK_ACCOUNT_ROLES = ["manage-account", "manage-account-links", "view-profile"];

export const CONSUMER_PERSONAS: readonly DevIdpPersona[] = [
  {
    id: "new-member",
    description: "New member: no Webflix account uses this email",
    email: "riley.chen@example.com",
    name: "Riley Chen",
  },
  {
    id: "demo-verified",
    description: "Email matches the seeded demo account, verified by the provider",
    email: DEMO_ACCOUNT_EMAIL,
    emailVerified: true,
    name: "Dana Demo",
  },
  {
    id: "demo-unverified",
    description: "Email matches the seeded demo account, NOT verified by the provider",
    email: DEMO_ACCOUNT_EMAIL,
    emailVerified: false,
    name: "Dana Unverified",
  },
  {
    id: "no-email",
    description: "The provider sends no email claim at all",
    email: null,
    name: "Noor Haddad",
  },
  {
    id: "renamed",
    description: "The name changes on every sign-in",
    email: "sam.rivera@example.com",
    name: ["Sam Rivera", "Samantha Rivera-Ortiz", "Sam R."],
  },
];

/** Apple users may hide their address behind a relay. */
const APPLE_PERSONAS: readonly DevIdpPersona[] = [
  {
    id: "private-relay",
    description: "Hides their address behind Apple's private email relay",
    email: "x7k2m9q4bd@privaterelay.appleid.com",
    isPrivateEmail: true,
    name: "Alex Morgan",
  },
];

function staff(
  id: string,
  name: string,
  email: string,
  description: string,
  clientRoles: Record<string, readonly string[]>,
): DevIdpPersona {
  return {
    id,
    description,
    email,
    name,
    roles: {
      realm: KEYCLOAK_DEFAULT_REALM_ROLES,
      clients: { ...clientRoles, account: KEYCLOAK_ACCOUNT_ROLES },
    },
  };
}

export const STAFF_PERSONAS: readonly DevIdpPersona[] = [
  staff("staff-support", "Jordan Lee", "jordan.lee@staff.webflix.dev", "Staff: support", {
    [STAFF_ROLE_CLIENT]: ["support"],
  }),
  staff("staff-billing", "Priya Natarajan", "priya.natarajan@staff.webflix.dev", "Staff: billing", {
    [STAFF_ROLE_CLIENT]: ["billing"],
  }),
  staff("staff-content", "Mateo Alvarez", "mateo.alvarez@staff.webflix.dev", "Staff: content", {
    [STAFF_ROLE_CLIENT]: ["content"],
  }),
  staff("staff-experiments", "Hana Sato", "hana.sato@staff.webflix.dev", "Staff: experiments", {
    [STAFF_ROLE_CLIENT]: ["experiments"],
  }),
  staff("staff-admin", "Morgan Blake", "morgan.blake@staff.webflix.dev", "Staff: admin", {
    [STAFF_ROLE_CLIENT]: ["admin"],
  }),
  staff(
    "staff-no-role",
    "Casey Quinn",
    "casey.quinn@staff.webflix.dev",
    "Staff account with no Webflix role",
    {},
  ),
  staff(
    "staff-other-client-admin",
    "Robin Park",
    "robin.park@staff.webflix.dev",
    "admin of another application only: no Webflix role",
    { "other-app": ["admin"] },
  ),
];

export function defaultPersonas(profile: ProfileName): readonly DevIdpPersona[] {
  switch (profile) {
    case "google":
      return CONSUMER_PERSONAS;
    case "apple":
      return [...CONSUMER_PERSONAS, ...APPLE_PERSONAS];
    case "keycloak":
      return STAFF_PERSONAS;
    case "generic":
      return [...CONSUMER_PERSONAS, ...STAFF_PERSONAS];
  }
}

/**
 * Who signed in, as codes, sessions and refresh tokens carry it: a configured persona by id, or
 * an address typed on the sign-in page.
 */
export type PersonaRef = { id: string } | { email: string; name: string | null; verified: boolean };

/** The identity one sign-in asserts. */
export interface Identity {
  personaId: string | null;
  sub: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  picture: string | null;
  isPrivateEmail: boolean;
  roles: PersonaRoles;
  extra: Readonly<Record<string, JsonValue>>;
}

const subjects = new Map<string, string>();

/**
 * A stable `sub` shaped like the profile's: Google's are 21 digits, Apple's look like
 * `000123.<32 hex>.0456`, Keycloak's are UUIDs. Derived from the issuer and the persona, so it is
 * the same on every instance and every restart.
 */
export async function deriveSubject(
  profile: Profile,
  issuer: string,
  key: string,
): Promise<string> {
  const cacheKey = `${profile.subjectFormat}\n${issuer}\n${key}`;
  const cached = subjects.get(cacheKey);
  if (cached) return cached;
  const digest = await sha256(`webflix-dev-idp/sub\n${issuer}\n${key}`);
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let sub: string;
  if (profile.subjectFormat === "numeric") {
    sub = `1${(BigInt(`0x${hex.slice(0, 18)}`) % 10n ** 20n).toString().padStart(20, "0")}`;
  } else if (profile.subjectFormat === "apple") {
    const n = Number.parseInt(hex.slice(32, 40), 16);
    sub = `000${String(n % 1000).padStart(3, "0")}.${hex.slice(0, 32)}.${String(n % 10_000).padStart(4, "0")}`;
  } else {
    const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
    sub = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
  // Typed addresses add entries for as long as a dev server runs: keep the cache bounded.
  if (subjects.size >= 10_000) subjects.clear();
  subjects.set(cacheKey, sub);
  return sub;
}

/** "riley.chen" → "Riley Chen", for addresses typed on the sign-in page. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return words.join(" ") || local;
}

function splitName(name: string | null): { givenName: string | null; familyName: string | null } {
  if (!name) return { givenName: null, familyName: null };
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { givenName: name, familyName: null };
  return { givenName: parts.slice(0, -1).join(" "), familyName: parts.at(-1) ?? null };
}

export function personaName(persona: DevIdpPersona, signInNumber: number): string | null {
  if (persona.name === undefined || persona.name === null) return null;
  if (typeof persona.name === "string") return persona.name;
  return persona.name[signInNumber % persona.name.length] ?? null;
}

export interface ResolveIdentityInput {
  profile: Profile;
  issuer: string;
  personas: readonly DevIdpPersona[];
  ref: PersonaRef;
  /** Which of a persona's names this sign-in uses. */
  nameIndex: number;
  /** Fault `subjectChanged`. */
  subjectChanged?: boolean;
}

export async function resolveIdentity(input: ResolveIdentityInput): Promise<Identity | null> {
  const { profile, issuer, ref } = input;
  const salt = input.subjectChanged ? "\nchanged" : "";
  if ("id" in ref) {
    const persona = input.personas.find((candidate) => candidate.id === ref.id);
    if (!persona) return null;
    const key = `persona:${persona.id}`;
    const sub =
      persona.sub !== undefined && !input.subjectChanged
        ? persona.sub
        : await deriveSubject(profile, issuer, `${key}${salt}`);
    const name = personaName(persona, input.nameIndex);
    const avatarKey = await deriveSubject(PROFILE_FOR_AVATARS, issuer, key);
    return {
      personaId: persona.id,
      sub,
      email: persona.email,
      emailVerified: persona.email === null ? null : (persona.emailVerified ?? true),
      name,
      ...splitName(name),
      picture:
        persona.picture === undefined
          ? `${issuer}/avatars/${avatarKey.replace(/-/g, "").slice(0, 16)}.svg`
          : persona.picture,
      isPrivateEmail: persona.isPrivateEmail ?? false,
      roles: persona.roles ?? {},
      extra: persona.claims ?? {},
    };
  }
  const key = `email:${ref.email.toLowerCase()}`;
  const sub = await deriveSubject(profile, issuer, `${key}${salt}`);
  const name = ref.name ?? nameFromEmail(ref.email);
  return {
    personaId: null,
    sub,
    email: ref.email,
    emailVerified: ref.verified,
    name,
    ...splitName(name),
    picture: null,
    isPrivateEmail: false,
    roles: {},
    extra: {},
  };
}

// Avatar file names are hex, whatever the profile's subject format.
const PROFILE_FOR_AVATARS = { subjectFormat: "uuid" } as Profile;
