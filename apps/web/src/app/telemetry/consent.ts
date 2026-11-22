/**
 * The consent part of the session store: what applies to the caller (`GET /privacy/consent`),
 * and recording the member's answer (`PUT /privacy/consent`, one purpose per request).
 *
 * The consent is per account (signed out: the deployment's default for an anonymous device),
 * so it is cached per account and never shown to, or applied for, another one. Every tab of the
 * browser hears about an answer at once (BroadcastChannel), so a withdrawal in one tab stops
 * collection in all of them.
 */
import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConsentPurpose,
  ConsentState,
  SessionState,
  UpdateConsentBody,
} from "@webflix/contracts";
import { useCallback, useState } from "react";
import { api } from "../api.ts";
import { useSession } from "../session/session.ts";
import type { Purposes } from "./policy.ts";

const MINUTE = 60_000;

/** The account the consent belongs to, or `anonymous` for a signed-out device. */
export function consentOwner(session: SessionState): string {
  return session.authenticated ? session.account.id : "anonymous";
}

export const consentKey = (owner: string) => ["webflix", "privacy", "consent", owner] as const;

export function isConsentKey(key: readonly unknown[]): boolean {
  return key[0] === "webflix" && key[1] === "privacy" && key[2] === "consent";
}

export const consentQuery = (owner: string) =>
  queryOptions({
    queryKey: consentKey(owner),
    queryFn: ({ signal }) => api().getConsent(undefined, { signal }),
    staleTime: 5 * MINUTE,
    // Never a toast: a consent that cannot be read only means nothing is collected meanwhile.
    meta: { silent: true },
  });

/** The consent in force for the current session (the prompt, Account › Privacy). */
export function useConsent() {
  const session = useSession();
  return useQuery(consentQuery(consentOwner(session)));
}

// --- Telling the other tabs ------------------------------------------------------------------

const CHANNEL = "webflix-privacy";

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
}

/** Another tab recorded an answer: re-read this owner's consent. Returns a stop function. */
export function listenForConsentElsewhere(queryClient: QueryClient): () => void {
  const listener = channel();
  if (!listener) return () => {};
  listener.onmessage = (message: MessageEvent<{ owner?: unknown; state?: unknown }>) => {
    const owner = message.data?.owner;
    if (typeof owner !== "string") return;
    const state = message.data.state as ConsentState | undefined;
    if (state) queryClient.setQueryData(consentKey(owner), state);
    else void queryClient.invalidateQueries({ queryKey: consentKey(owner) });
  };
  return () => listener.close();
}

function tellOtherTabs(owner: string, state: ConsentState | null): void {
  const sender = channel();
  if (!sender) return;
  sender.postMessage({ owner, state: state ?? undefined });
  sender.close();
}

// --- Answering -------------------------------------------------------------------------------

/** Purposes in the order a combined answer records them. */
const PURPOSES: readonly ConsentPurpose[] = ["personalisation", "analytics"];

/**
 * Record answers for one or both purposes. A withdrawal takes effect in this browser before
 * the server has answered (the consent in the cache changes at once, so collection stops and
 * the queue is emptied); a grant takes effect only once the server has recorded it.
 */
export async function answerConsent(
  queryClient: QueryClient,
  owner: string,
  answers: Partial<Purposes>,
  source: UpdateConsentBody["source"],
): Promise<ConsentState> {
  const key = consentKey(owner);
  const current = queryClient.getQueryData<ConsentState>(key);
  const withdrawals = PURPOSES.filter((purpose) => answers[purpose] === false);
  if (current && withdrawals.length > 0) {
    const now = new Date().toISOString();
    const purposes = { ...current.purposes };
    for (const purpose of withdrawals) {
      purposes[purpose] = { granted: false, source, updatedAt: now };
    }
    queryClient.setQueryData<ConsentState>(key, { ...current, purposes });
    tellOtherTabs(owner, { ...current, purposes });
  }
  let latest: ConsentState | undefined;
  try {
    for (const purpose of PURPOSES) {
      const granted = answers[purpose];
      if (granted === undefined) continue;
      latest = await api().updateConsent({ body: { purpose, granted, source } });
    }
  } catch (error) {
    // Show the truth again (a withdrawal the server did not record is not in force there).
    void queryClient.invalidateQueries({ queryKey: key });
    throw error;
  }
  if (!latest) throw new Error("answerConsent called without an answer");
  queryClient.setQueryData(key, latest);
  tellOtherTabs(owner, latest);
  return latest;
}

/** `answerConsent` for the current session, with its pending state and last error. */
export function useAnswerConsent() {
  const queryClient = useQueryClient();
  const session = useSession();
  const owner = consentOwner(session);
  const [pending, setPending] = useState<Partial<Record<ConsentPurpose, boolean>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const answer = useCallback(
    async (answers: Partial<Purposes>, source: UpdateConsentBody["source"]) => {
      setPending(answers);
      setError(null);
      try {
        return await answerConsent(queryClient, owner, answers, source);
      } catch (caught) {
        setError(caught);
        throw caught;
      } finally {
        setPending(null);
      }
    },
    [queryClient, owner],
  );
  return { answer, pending, error, resetError: () => setError(null) };
}
