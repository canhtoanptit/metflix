/** Tables of the identity area (migrations 0002_identity, 0010_identity_claims). Representations: see schema.ts. */

export interface AccountIdentitiesTable {
  provider: string;
  subject: string;
  account_id: string;
  issuer: string;
  email_at_link: string | null;
  created_at: number;
  last_used_at: number;
}

export interface AccountTokensTable {
  token_hash: string;
  account_id: string;
  /** `verify_email` | `reset_password`. */
  purpose: string;
  email: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

export interface EmailOutboxTable {
  id: string;
  idempotency_key: string;
  to_address: string;
  from_address: string;
  template: string;
  subject: string;
  html_body: string | null;
  text_body: string | null;
  status: string;
  provider_message_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

export interface EmailSuppressionsTable {
  address: string;
  reason: string;
  source: string;
  created_at: number;
}

/** Single-use claims (migration 0010_identity_claims): a processed OpenID callback. */
export interface IdentityClaimsTable {
  claim_key: string;
  expires_at: number;
}

export interface IdentityTables {
  account_identities: AccountIdentitiesTable;
  account_tokens: AccountTokensTable;
  email_outbox: EmailOutboxTable;
  email_suppressions: EmailSuppressionsTable;
  identity_claims: IdentityClaimsTable;
}

/** Parents first. */
export const IDENTITY_TABLES = [
  "account_identities",
  "account_tokens",
  "email_outbox",
  "email_suppressions",
  "identity_claims",
] as const satisfies readonly (keyof IdentityTables)[];
