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
import { privacyRequestsQuery, scheduledDeletion } from "./requests.ts";

export function AccountPrivacyPage() {
  const requests = useQuery(privacyRequestsQuery());
  // A deletion waiting to happen is the most important thing here: it comes first.
  const scheduled = requests.data ? scheduledDeletion(requests.data.items) !== undefined : false;
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
