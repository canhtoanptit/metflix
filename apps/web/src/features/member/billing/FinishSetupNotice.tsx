import type { SessionState } from "@webflix/contracts";
import { Button } from "@webflix/ui";
import { FormAlert } from "../shared/FormAlert.tsx";
import { HrefLink } from "./HrefLink.tsx";
import { isUnfinishedSignup, signupStage } from "./membership.ts";

/**
 * Finishing sign-up, offered on the account pages of an account that has not finished it (UX
 * review 1.1): what is left, and one way to carry on where it stopped (`/signup` resumes at the
 * step the account's state calls for). Nothing for an account that is set up.
 */
export function FinishSetupNotice({ session }: { session: SessionState }) {
  if (!isUnfinishedSignup(session)) return null;
  const stage = signupStage(session);
  const copy =
    stage === "payment"
      ? {
          title: "Your first payment isn't confirmed yet",
          body: "Your membership starts as soon as it is. Then create your profiles and start watching.",
          action: "Finish payment",
          href: "/signup",
        }
      : stage === "profiles"
        ? {
            title: "Create your profiles to start watching",
            body: "Your membership is ready. Add a profile for everyone who watches.",
            action: "Create profiles",
            href: "/signup/profile",
          }
        : {
            title: "Finish setting up Webflix",
            body: "Choose a plan and create your profiles to start watching.",
            action: "Finish setting up",
            href: "/signup",
          };
  return (
    <FormAlert
      tone="accent"
      title={copy.title}
      action={
        <Button variant="accent" size="sm" asChild>
          <HrefLink href={copy.href}>{copy.action}</HrefLink>
        </Button>
      }
    >
      {copy.body}
    </FormAlert>
  );
}
