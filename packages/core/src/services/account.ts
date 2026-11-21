import type { AccountDetails, DeviceSessionList, Membership, PlanId } from "@webflix/contracts";
import { getPlan } from "../domain/plans.ts";
import { AppError } from "../errors.ts";
import { UniqueViolationError } from "../repositories/ports.ts";
import type { SubscriptionRecord } from "../repositories/records.ts";
import type { AuthContext, ServiceDependencies } from "./context.ts";
import { type ChargeCredentialCheck, createCredentialChecks } from "./credentials.ts";
import {
  presentAccount,
  presentDevice,
  presentPaymentMethod,
  presentSubscription,
} from "./presenters.ts";
import { requireNotDemo } from "./privileges.ts";
import { BILLING_PERIOD_MS, type CardInput, effectiveSubscription } from "./subscriptions.ts";

export interface UpdateAccountInput {
  currentPassword: string;
  email?: string | undefined;
  newPassword?: string | undefined;
}

export interface ChangePlanInput {
  planId: PlanId;
  payment?: CardInput | undefined;
}

/**
 * Account management. Who may call it (a profile without parental controls) is enforced by the
 * HTTP guard (`auth: "account-holder"`, `privileges.ts`); the shared demo account keeps its
 * sign-in details, membership and other devices whoever is signed in to it.
 */
export function createAccountService(deps: ServiceDependencies) {
  const { repos, clock, passwords, billing, streamGate, logger } = deps;
  const credentials = createCredentialChecks(deps);

  async function load(accountId: string) {
    const loaded = await repos.accounts.get(accountId);
    if (!loaded) throw new AppError("unauthenticated");
    return loaded;
  }

  function membership(subscription: SubscriptionRecord): Membership {
    return {
      subscription: presentSubscription(subscription, clock.now()),
      plan: getPlan(subscription.planId),
    };
  }

  async function charge(card: CardInput | SubscriptionRecord["card"], amountMinor: number) {
    if (!card) {
      throw new AppError("payment_declined", {
        declineReason: "card_declined",
        detail: "No payment method on file. Add a card to continue.",
      });
    }
    const result = await billing.charge({ card, amountMinor, currency: "USD", now: clock.now() });
    if (!result.approved) throw new AppError("payment_declined", { declineReason: result.reason });
    return result.card;
  }

  /** On a plan with fewer screens, end the newest streams beyond the new limit. */
  async function trimStreams(accountId: string, limit: number): Promise<void> {
    const leases = await streamGate.list(accountId);
    for (const lease of leases.slice(limit)) {
      await streamGate.release(accountId, lease.playbackSessionId);
    }
  }

  return {
    async getAccount(accountId: string): Promise<AccountDetails> {
      const { account, subscription } = await load(accountId);
      return {
        account: presentAccount(account),
        subscription: presentSubscription(subscription, clock.now()),
        plan: getPlan(subscription.planId),
        paymentMethod: presentPaymentMethod(subscription),
      };
    },

    async updateAccount(
      auth: AuthContext,
      input: UpdateAccountInput,
      charge: ChargeCredentialCheck,
    ): Promise<AccountDetails> {
      const accountId = auth.session.accountId;
      requireNotDemo(accountId);
      const { account } = await load(accountId);
      await credentials.requirePassword(accountId, input.currentPassword, charge);
      const now = clock.now();
      if (input.email !== undefined && input.email !== account.email) {
        try {
          await repos.accounts.updateEmail(accountId, input.email, now);
        } catch (error) {
          if (error instanceof UniqueViolationError) throw new AppError("email_already_registered");
          throw error;
        }
      }
      if (input.newPassword !== undefined) {
        // Other devices lose their sessions and their streams; this one stays signed in.
        const others = (await repos.sessions.listForAccount(accountId, now)).filter(
          (session) => session.id !== auth.session.id,
        );
        await repos.accounts.changePassword({
          accountId,
          passwordHash: await passwords.hash(input.newPassword),
          keepSessionId: auth.session.id,
          now,
        });
        for (const session of others) await streamGate.releaseDevice(accountId, session.id);
      }
      return this.getAccount(accountId);
    },

    async changePlan(accountId: string, input: ChangePlanInput): Promise<Membership> {
      requireNotDemo(accountId);
      const { subscription } = await load(accountId);
      const now = clock.now();
      const current = getPlan(subscription.planId);
      const next = getPlan(input.planId);
      const effective = effectiveSubscription(subscription, now);
      let updated: SubscriptionRecord;

      if (effective.status === "ended") {
        // Restarting an ended membership: a full new period, charged now.
        const card = await charge(
          input.payment ?? subscription.card,
          next.monthlyPrice.amountMinor,
        );
        updated = {
          ...subscription,
          planId: next.id,
          currentPeriodEnd: now + BILLING_PERIOD_MS,
          canceledAt: null,
          card,
          updatedAt: now,
        };
      } else {
        if (next.id === current.id && !input.payment) return membership(subscription);
        // Upgrades pay the prorated difference for the rest of the period; downgrades and a
        // new card on the same plan verify the card with a zero-amount authorisation.
        const remaining = Math.max(0, effective.currentPeriodEnd - now) / BILLING_PERIOD_MS;
        const difference = next.monthlyPrice.amountMinor - current.monthlyPrice.amountMinor;
        const amount = Math.max(0, Math.round(difference * remaining));
        const card =
          amount > 0 || input.payment
            ? await charge(input.payment ?? subscription.card, amount)
            : subscription.card;
        updated = {
          ...subscription,
          planId: next.id,
          currentPeriodEnd: effective.currentPeriodEnd,
          card,
          updatedAt: now,
        };
      }
      await repos.accounts.saveSubscription(updated);
      if (next.maxStreams < current.maxStreams) await trimStreams(accountId, next.maxStreams);
      logger.info("account.plan_changed", { accountId, from: current.id, to: next.id });
      return membership(updated);
    },

    /**
     * Replace the card on file: verified with a zero-amount authorisation, declined exactly like
     * at sign-up (nothing changes then). Only what `StoredCard` holds is kept.
     */
    async updatePaymentMethod(accountId: string, payment: CardInput): Promise<AccountDetails> {
      requireNotDemo(accountId);
      const { subscription } = await load(accountId);
      const card = await charge(payment, 0);
      await repos.accounts.saveSubscription({ ...subscription, card, updatedAt: clock.now() });
      logger.info("account.payment_method_updated", { accountId, brand: card.brand });
      return this.getAccount(accountId);
    },

    async cancel(accountId: string): Promise<Membership> {
      requireNotDemo(accountId);
      const { subscription } = await load(accountId);
      const now = clock.now();
      const effective = effectiveSubscription(subscription, now);
      if (effective.status !== "active") return membership(subscription);
      const updated: SubscriptionRecord = {
        ...subscription,
        currentPeriodEnd: effective.currentPeriodEnd,
        canceledAt: now,
        updatedAt: now,
      };
      await repos.accounts.saveSubscription(updated);
      return membership(updated);
    },

    async resume(accountId: string): Promise<Membership> {
      // Allowed on the demo account: it can only bring a membership back.
      const { subscription } = await load(accountId);
      const now = clock.now();
      const effective = effectiveSubscription(subscription, now);
      if (effective.status === "active") return membership(subscription);
      let updated: SubscriptionRecord;
      if (effective.status === "canceling") {
        updated = { ...subscription, canceledAt: null, updatedAt: now };
      } else {
        const plan = getPlan(subscription.planId);
        const card = await charge(subscription.card, plan.monthlyPrice.amountMinor);
        updated = {
          ...subscription,
          currentPeriodEnd: now + BILLING_PERIOD_MS,
          canceledAt: null,
          card,
          updatedAt: now,
        };
      }
      await repos.accounts.saveSubscription(updated);
      return membership(updated);
    },

    async listDevices(auth: AuthContext): Promise<DeviceSessionList> {
      const sessions = await repos.sessions.listForAccount(auth.session.accountId, clock.now());
      return { items: sessions.map((session) => presentDevice(session, auth.session.id)) };
    },

    async revokeDevice(auth: AuthContext, sessionId: string): Promise<void> {
      // Signing this device out is always fine; other demo visitors are not ours to sign out.
      if (sessionId !== auth.session.id) requireNotDemo(auth.session.accountId);
      const deleted = await repos.sessions.delete(auth.session.accountId, sessionId);
      if (!deleted) throw new AppError("not_found", { detail: "No such device" });
      await streamGate.releaseDevice(auth.session.accountId, sessionId);
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
