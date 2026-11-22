/** Tables of the billing area (migrations 0003_billing, 0008_billing_projection). Representations: see schema.ts. */

export interface BillingCustomersTable {
  account_id: string;
  provider: string;
  customer_id: string;
  created_at: number;
}

export interface MembershipsTable {
  account_id: string;
  provider: string;
  provider_customer_id: string;
  provider_subscription_id: string | null;
  plan_id: string | null;
  price_lookup_key: string | null;
  status: string;
  suspended_reason: string | null;
  cancel_at_period_end: number;
  trial_ends_at: number | null;
  current_period_start: number | null;
  current_period_end: number | null;
  grace_started_at: number | null;
  ended_at: number | null;
  latest_invoice_id: string | null;
  payment_method_json: string | null;
  trial_redeemed_at: number | null;
  /** 0008: the invoice whose first failed attempt started grace. */
  grace_invoice_id: string | null;
  /** 0008: provider time minus ours (a test clock); 0 in real time. */
  clock_offset_ms: number | null;
  version: number;
  provider_synced_at: number;
  created_at: number;
  updated_at: number;
}

export interface BillingOperationsTable {
  id: string;
  account_id: string;
  kind: string;
  attempt: number;
  idempotency_key: string;
  status: string;
  provider: string;
  provider_ref: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderEventsTable {
  provider: string;
  event_id: string;
  type: string;
  account_id: string | null;
  idempotency_key: string | null;
  received_at: number;
  processed_at: number | null;
  status: string;
  attempts: number;
  last_error: string | null;
  /** 0008: the verified event's normalised ids and time. */
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  provider_invoice_id: string | null;
  provider_setup_id: string | null;
  event_created_at: number | null;
  /** 0008: `webhook` or `reconcile`. */
  source: string | null;
}

export interface TrialFingerprintsTable {
  provider: string;
  fingerprint: string;
  account_id: string;
  created_at: number;
}

export interface InvoicesTable {
  id: string;
  account_id: string;
  provider: string;
  provider_invoice_id: string;
  provider_subscription_id: string | null;
  number: string | null;
  status: string;
  currency: string;
  total_minor: number;
  amount_paid_minor: number;
  amount_due_minor: number;
  amount_refunded_minor: number;
  billing_reason: string;
  period_start: number | null;
  period_end: number | null;
  hosted_url: string | null;
  pdf_url: string | null;
  issued_at: number;
  paid_at: number | null;
  updated_at: number;
}

export interface RefundsTable {
  id: string;
  account_id: string;
  invoice_id: string;
  provider: string;
  provider_refund_id: string | null;
  amount_minor: number;
  currency: string;
  status: string;
  reason: string | null;
  staff_subject: string | null;
  created_at: number;
  updated_at: number;
}

export interface PlanPricesTable {
  plan_id: string;
  currency: string;
  amount_minor: number;
  lookup_key: string;
  active: number;
  updated_at: number;
}

export interface ProviderPricesTable {
  provider: string;
  lookup_key: string;
  provider_price_id: string;
  amount_minor: number;
  synced_at: number;
}

export interface CheckoutsTable {
  id: string;
  account_id: string;
  plan_id: string;
  currency: string;
  status: string;
  promotion_code: string | null;
  provider: string;
  provider_customer_id: string | null;
  provider_setup_id: string | null;
  provider_subscription_id: string | null;
  trial_days: number | null;
  amount_due_minor: number | null;
  failure_reason: string | null;
  operation_id: string | null;
  created_at: number;
  expires_at: number;
  updated_at: number;
  /** 0008. */
  promotion_id: string | null;
  promotion_json: string | null;
  provider_payment_method_id: string | null;
  trial_fingerprint: string | null;
  attempt: number | null;
}

export interface PaymentMethodSetupsTable {
  id: string;
  account_id: string;
  provider: string;
  provider_setup_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  /** 0008. */
  provider_payment_method_id: string | null;
  attempt: number | null;
}

export interface PaymentsFakeObjectsTable {
  kind: string;
  id: string;
  customer_id: string | null;
  data_json: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface PaymentsFakeIdempotencyTable {
  idempotency_key: string;
  fingerprint: string;
  outcome_json: string;
  created_at: number;
}

export interface PaymentsFakeClocksTable {
  customer_id: string;
  now_ms: number;
  updated_at: number;
}

export interface BillingTables {
  billing_customers: BillingCustomersTable;
  memberships: MembershipsTable;
  billing_operations: BillingOperationsTable;
  provider_events: ProviderEventsTable;
  trial_fingerprints: TrialFingerprintsTable;
  invoices: InvoicesTable;
  refunds: RefundsTable;
  plan_prices: PlanPricesTable;
  provider_prices: ProviderPricesTable;
  checkouts: CheckoutsTable;
  payment_method_setups: PaymentMethodSetupsTable;
  payments_fake_objects: PaymentsFakeObjectsTable;
  payments_fake_idempotency: PaymentsFakeIdempotencyTable;
  payments_fake_clocks: PaymentsFakeClocksTable;
}

/** Parents first. */
export const BILLING_TABLES = [
  "billing_customers",
  "memberships",
  "billing_operations",
  "provider_events",
  "trial_fingerprints",
  "invoices",
  "refunds",
  "plan_prices",
  "provider_prices",
  "checkouts",
  "payment_method_setups",
  "payments_fake_objects",
  "payments_fake_idempotency",
  "payments_fake_clocks",
] as const satisfies readonly (keyof BillingTables)[];
