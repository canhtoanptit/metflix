/**
 * Provider profiles: the observable behaviours that differ between the issuers Webflix trusts.
 * Each was checked against the provider's published discovery document (2026-11); the README
 * lists what the stand-in still does differently.
 */

export const PROFILE_NAMES = ["generic", "google", "apple", "keycloak"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export interface Profile {
  readonly name: ProfileName;
  /** Shown on the sign-in page: which real issuer this one imitates. */
  readonly standsInFor: string;
  readonly scopes: readonly string[];
  readonly subjectType: "public" | "pairwise";
  /** Shape of generated `sub` values. Relying parties must treat `sub` as opaque either way. */
  readonly subjectFormat: "uuid" | "numeric" | "apple";
  /** Apple documents `email_verified` and `is_private_email` as "a string or Boolean". */
  readonly booleanClaimsAsStrings: boolean;
  /** `name`, `given_name`, `family_name`, `picture` in the ID token (with the `profile` scope). */
  readonly profileClaimsInIdToken: boolean;
  /** Apple: the name arrives once, in a `user` form field of the first authorisation response. */
  readonly nameOnFirstAuthorisationOnly: boolean;
  /** `opaque`: only the issuer can read the access token (Google, Apple). */
  readonly accessTokenFormat: "jwt" | "opaque";
  /** `rfc9068`: `typ: at+jwt`, `client_id`; `keycloak`: `typ: JWT`, `azp`, `typ: Bearer` claim. */
  readonly accessTokenStyle: "rfc9068" | "keycloak";
  readonly userinfo: boolean;
  readonly endSession: boolean;
  /** When a refresh token is issued. */
  readonly refreshTokens: "offline_access" | "access_type_offline" | "always";
  /** RFC 9207 `iss` in the authorisation response. */
  readonly authorizationResponseIss: boolean;
  readonly azp: boolean;
  /** Apple: these scopes may only be requested with `response_mode=form_post`. */
  readonly formPostScopes: readonly string[];
  readonly tokenEndpointAuthMethods: readonly string[];
  readonly claimsSupported: readonly string[];
  /**
   * The client-credentials grant (RFC 6749 §4.4) for clients with a service account (Keycloak's
   * service accounts; Google and Apple have no such grant for relying parties).
   */
  readonly clientCredentials: boolean;
}

const COMMON_CLAIMS = ["iss", "sub", "aud", "exp", "iat", "auth_time", "nonce", "at_hash"];

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  generic: {
    name: "generic",
    standsInFor: "a generic OpenID provider",
    scopes: ["openid", "email", "profile", "offline_access"],
    subjectType: "public",
    subjectFormat: "uuid",
    booleanClaimsAsStrings: false,
    profileClaimsInIdToken: true,
    nameOnFirstAuthorisationOnly: false,
    accessTokenFormat: "jwt",
    accessTokenStyle: "rfc9068",
    userinfo: true,
    endSession: true,
    refreshTokens: "offline_access",
    authorizationResponseIss: true,
    azp: true,
    formPostScopes: [],
    tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post", "none"],
    clientCredentials: true,
    claimsSupported: [
      ...COMMON_CLAIMS,
      "azp",
      "sid",
      "email",
      "email_verified",
      "name",
      "given_name",
      "family_name",
      "picture",
    ],
  },
  google: {
    name: "google",
    standsInFor: "Google",
    scopes: ["openid", "email", "profile"],
    subjectType: "public",
    subjectFormat: "numeric",
    booleanClaimsAsStrings: false,
    profileClaimsInIdToken: true,
    nameOnFirstAuthorisationOnly: false,
    accessTokenFormat: "opaque",
    accessTokenStyle: "rfc9068",
    userinfo: true,
    endSession: false,
    refreshTokens: "access_type_offline",
    authorizationResponseIss: true,
    azp: true,
    formPostScopes: [],
    tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
    clientCredentials: false,
    claimsSupported: [
      ...COMMON_CLAIMS,
      "azp",
      "email",
      "email_verified",
      "name",
      "given_name",
      "family_name",
      "picture",
    ],
  },
  apple: {
    name: "apple",
    standsInFor: "Sign in with Apple",
    scopes: ["openid", "email", "name"],
    subjectType: "pairwise",
    subjectFormat: "apple",
    booleanClaimsAsStrings: true,
    profileClaimsInIdToken: false,
    nameOnFirstAuthorisationOnly: true,
    accessTokenFormat: "opaque",
    accessTokenStyle: "rfc9068",
    userinfo: false,
    endSession: false,
    refreshTokens: "always",
    authorizationResponseIss: false,
    azp: false,
    formPostScopes: ["email", "name"],
    tokenEndpointAuthMethods: ["client_secret_post"],
    clientCredentials: false,
    claimsSupported: [
      ...COMMON_CLAIMS,
      "email",
      "email_verified",
      "is_private_email",
      "nonce_supported",
      "real_user_status",
    ],
  },
  keycloak: {
    name: "keycloak",
    standsInFor: "Keycloak (staff realm)",
    scopes: ["openid", "email", "profile", "offline_access", "roles"],
    subjectType: "public",
    subjectFormat: "uuid",
    booleanClaimsAsStrings: false,
    profileClaimsInIdToken: true,
    nameOnFirstAuthorisationOnly: false,
    accessTokenFormat: "jwt",
    accessTokenStyle: "keycloak",
    userinfo: true,
    endSession: true,
    refreshTokens: "always",
    authorizationResponseIss: true,
    azp: true,
    formPostScopes: [],
    tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post", "none"],
    clientCredentials: true,
    claimsSupported: [
      ...COMMON_CLAIMS,
      "azp",
      "sid",
      "email",
      "email_verified",
      "name",
      "given_name",
      "family_name",
      "preferred_username",
      "picture",
    ],
  },
};
