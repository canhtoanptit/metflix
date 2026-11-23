/**
 * Account › Privacy (docs/BLUEPRINT-M2.md §6.3): how Webflix uses the member's activity, a copy
 * of their data, and deleting the account. Only the account holder gets here (the account frame
 * turns kids and restricted profiles away), so every answer given here is the account's.
 */
import { useQuery } from "@tanstack/react-query";
import { AccountHeading } from "../AccountLayout.tsx";
import { ConsentSection } from "./ConsentSection.tsx";
import { DeletionSection } from "./DeletionSection.tsx";
import { ExportSection } from "./ExportSection.tsx";
import { deletionInProgress, privacyRequestsQuery, scheduledDeletion } from "./requests.ts";

export function AccountPrivacyPage() {
  const requests = useQuery(privacyRequestsQuery());
  const items = requests.data?.items ?? [];
  // The account is being erased: nothing else on the page can work any more, so it says only that.
  if (deletionInProgress(items)) {
    return (
      <>
        <AccountHeading title="Privacy" />
        <DeletionSection />
      </>
    );
  }
  // A deletion waiting to happen is the most important thing here: it comes first.
  const scheduled = scheduledDeletion(items) !== undefined;
  return (
    <>
      <AccountHeading
        title="Privacy"
        description="Choose how Webflix uses your activity, get a copy of your data, or delete your account."
      />
      {scheduled ? <DeletionSection /> : null}
      <ConsentSection />
      <ExportSection />
      {scheduled ? null : <DeletionSection />}
    </>
  );
}
