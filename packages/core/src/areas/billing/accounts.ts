import type { AccountRecord, SubscriptionRecord } from "../../repositories/records.ts";
import type { ServiceDependencies } from "../../services/context.ts";

/**
 * The account and milestone 1's mock membership row, if any: one read of the identity area
 * (`repos.identity.getAccountWithSubscription`), which, unlike milestone 1's
 * `repos.accounts.get`, also answers for an account created without payment (§5.1).
 */
export async function readAccount(
  deps: Pick<ServiceDependencies, "repos">,
  accountId: string,
): Promise<{ account: AccountRecord; subscription: SubscriptionRecord | null } | null> {
  const loaded = await deps.repos.identity.getAccountWithSubscription(accountId);
  if (!loaded) return null;
  const { account, subscription } = loaded;
  return {
    account: {
      id: account.id,
      email: account.email,
      // Milestone 1's record spells "no password" as the empty string; billing never reads it.
      passwordHash: account.passwordHash ?? "",
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    subscription,
  };
}
