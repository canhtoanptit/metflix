import type { ClientEventType, LakeEvent } from "@webflix/contracts";
import { makeClientEventInput } from "@webflix/contracts/fixtures";
import { drainOutboxJob } from "../../src/areas/events/jobs.ts";
import type { AuthContext, ProfileRecord, ProfileRow } from "../../src/index.ts";
import type { MemoryEventSink } from "../../src/memory/index.ts";
import {
  createTestServices,
  makeAccountRecord,
  makeProfileRow,
  makeSessionRecord,
  makeSubscriptionRecord,
  TEST_NOW,
  type TestServices,
  type TestServicesOptions,
} from "../../src/testing/index.ts";

export const DAY_MS = 24 * 3600 * 1000;

/** Services in memory with the events area's settings (opt-out by default: collection on). */
export async function eventServices(
  config: Record<string, string> = {},
  options: Omit<TestServicesOptions, "config"> = { seed: false },
): Promise<TestServices & { sink: MemoryEventSink }> {
  const t = await createTestServices({
    ...options,
    config: { WEBFLIX_CONSENT_MODE: "opt-out", ...config },
  });
  return { ...t, sink: t.ports.eventSink };
}

export interface Member {
  accountId: string;
  sessionId: string;
  profiles: { adult: ProfileRecord; kids: ProfileRecord; teen: ProfileRecord };
  /** The session's auth context with the given profile active (null: at the gate). */
  as(profile: "adult" | "kids" | "teen" | null): AuthContext;
}

/**
 * An account written straight through the repositories (so these tests do not depend on how
 * sign-up evolves): a premium membership, one live session and three profiles: an adult, a
 * kids profile and a teen profile with a lowered ceiling (both restricted).
 */
export async function createMember(
  t: TestServices,
  id = "acc-ev",
  options: { membership?: boolean } = {},
): Promise<Member> {
  const session = makeSessionRecord({
    id: `ses-${id}`,
    tokenHash: `hash-${id}`,
    accountId: id,
    createdAt: TEST_NOW,
    lastSeenAt: TEST_NOW,
    expiresAt: TEST_NOW + 30 * DAY_MS,
  });
  if (options.membership === false) {
    // Milestone 2's sign-up without a card: an account and a session, no membership at all.
    await t.deps.repos.identity.createAccount({
      account: {
        id,
        email: `${id}@example.com`,
        passwordHash: null,
        emailVerifiedAt: null,
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      },
      session,
      identity: null,
    });
  } else {
    await t.deps.repos.accounts.createWithSession({
      account: makeAccountRecord({ id, email: `${id}@example.com`, createdAt: TEST_NOW }),
      subscription: makeSubscriptionRecord({
        accountId: id,
        planId: "premium",
        startedAt: TEST_NOW,
      }),
      session,
    });
  }
  const rows: Record<"adult" | "kids" | "teen", ProfileRow> = {
    adult: makeProfileRow({ id: `${id}-adult`, accountId: id, name: "Sam" }),
    kids: makeProfileRow({
      id: `${id}-kids`,
      accountId: id,
      name: "Kiddo",
      isKids: true,
      maturityCeiling: "7+",
    }),
    teen: makeProfileRow({ id: `${id}-teen`, accountId: id, name: "Teen", maturityCeiling: "13+" }),
  };
  for (const row of Object.values(rows)) await t.deps.repos.profiles.createWithinLimit(row, 5);
  const profiles = {
    adult: { ...rows.adult, avatar: null },
    kids: { ...rows.kids, avatar: null },
    teen: { ...rows.teen, avatar: null },
  };
  return {
    accountId: id,
    sessionId: session.id,
    profiles,
    as(profile) {
      return {
        session: { ...session, activeProfileId: profile ? profiles[profile].id : null },
        profile: profile ? profiles[profile] : null,
      };
    },
  };
}

/** Grant the session a fresh account-holder proof (identity's elevation). */
export async function elevate(t: TestServices, member: Member, forSec = 300): Promise<void> {
  const now = t.clock.now();
  const ok = await t.deps.repos.identity.elevateSession(
    member.sessionId,
    member.accountId,
    now + forSec * 1000,
    now,
  );
  if (!ok) throw new Error("could not elevate the session");
}

let sequence = 0;
const DEVICE = "dev-events-test-1";

/** A valid client event of `type` from one test device, with a fresh id. */
export function clientEvent<T extends ClientEventType>(
  type: T,
  overrides: Partial<Record<string, unknown>> = {},
) {
  sequence += 1;
  return makeClientEventInput(type, {
    eventId: `0193a1d2-7c4e-7a10-8f00-${sequence.toString(16).padStart(12, "0")}`,
    deviceId: DEVICE,
    sessionSeq: sequence,
    ...overrides,
  });
}

/**
 * Process every job that is due (ingestion consumer, server events, privacy jobs), with a
 * drain of the event outbox (playback's events) as the scheduler would publish.
 */
export async function settle(t: TestServices): Promise<void> {
  await t.queue.publish(drainOutboxJob.create({}));
  await t.queue.drain();
}

export function lakeEvents(sink: MemoryEventSink): LakeEvent[] {
  return sink.events();
}
