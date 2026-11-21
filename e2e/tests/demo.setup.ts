import { request, test as setup } from "@playwright/test";
import { DEMO, selectProfile, signIn } from "./api.ts";
import { DEMO_PROFILES, demoStatePath } from "./fixtures.ts";

/**
 * One demo session per profile for the whole run, shared read-only by every spec that uses
 * `test.use({ demo })`. Signing in once here instead of once per test keeps the run inside the
 * sign-in budget of this address (and the profile-selection budget of the demo account) under
 * any rate-limit profile, and makes the suite independent of what ran before it: a refused
 * attempt is waited out, never failed.
 */
setup("sign in to the demo account, once per profile", async ({ baseURL }) => {
  setup.setTimeout(180_000);
  for (const name of DEMO_PROFILES) {
    const context = await request.newContext({ baseURL });
    try {
      const session = await signIn(context, DEMO);
      const profile = session.profiles.find((candidate) => candidate.name === name);
      if (!profile) throw new Error(`the demo account has no profile called ${name}`);
      await selectProfile(context, profile.id);
      await context.storageState({ path: demoStatePath(baseURL, name) });
    } finally {
      await context.dispose();
    }
  }
});
