import { ApiError, type ErrorCode } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState, type MockState } from "../src/mocks/state.ts";

/**
 * The mock API applies the server's privilege rules (who may manage the account and its
 * profiles, with which proof), so mock mode and the component tests meet the same refusals.
 * Seed: Mara (18+), Theo (18+, PIN 1234), Kids (kids, 7+); password `webflix-demo`.
 */
function mockApi(state: MockState) {
  return createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
}

function on(profileId: string | null, edit: (state: MockState) => void = () => {}): MockState {
  const state = initialState("account");
  state.activeProfileId = profileId;
  edit(state);
  return state;
}

const refusedWith = (code: ErrorCode) => (error: unknown) => ApiError.is(error, code);

describe("account management needs a profile without parental controls", () => {
  it("answers profile_required at the gate and unrestricted_profile_required on kids and restricted profiles", async () => {
    await expect(mockApi(on(null)).getAccount()).rejects.toSatisfy(refusedWith("profile_required"));
    await expect(mockApi(on("profile-kids")).listDevices()).rejects.toSatisfy(
      refusedWith("unrestricted_profile_required"),
    );
    const restricted = on("profile-mara", (state) => {
      const mara = state.profiles[0];
      if (mara) mara.maturityCeiling = "13+";
    });
    await expect(mockApi(restricted).cancelMembership()).rejects.toSatisfy(
      refusedWith("unrestricted_profile_required"),
    );
    const details = await mockApi(on("profile-mara")).getAccount();
    expect(details.account.isDemo).toBeUndefined();
  });
});

describe("profiles", () => {
  it("reports parental controls, and adding a profile then needs the password", async () => {
    const api = mockApi(on(null));
    expect((await api.listProfiles()).parentalControls).toBe(true);
    const avatarId = (await api.listAvatars()).groups[0]?.avatars[0]?.id ?? "";
    const body = { name: "Ana", avatarId };
    await expect(api.createProfile({ body })).rejects.toSatisfy(refusedWith("password_required"));
    await expect(
      api.createProfile({ body: { ...body, currentPassword: "nope" } }),
    ).rejects.toSatisfy(refusedWith("current_password_invalid"));
    const created = await api.createProfile({ body: { ...body, currentPassword: "webflix-demo" } });
    expect(created.name).toBe("Ana");

    const open = mockApi(
      on(null, (state) => {
        state.profiles = state.profiles.slice(0, 1);
      }),
    );
    expect((await open.listProfiles()).parentalControls).toBe(false);
    await expect(open.createProfile({ body: { name: "Ana", avatarId } })).resolves.toMatchObject({
      name: "Ana",
    });
  });

  it("closes profile management to kids profiles, except their own name, avatar and settings", async () => {
    const api = mockApi(on("profile-kids"));
    await expect(
      api.createProfile({ body: { name: "Ana", avatarId: "a", currentPassword: "webflix-demo" } }),
    ).rejects.toSatisfy(refusedWith("unrestricted_profile_required"));
    await expect(
      api.updateProfile({ params: { id: "profile-mara" }, body: { name: "Mum" } }),
    ).rejects.toSatisfy(refusedWith("unrestricted_profile_required"));
    await expect(
      api.updateProfile({
        params: { id: "profile-kids" },
        body: { isKids: false, currentPassword: "webflix-demo" },
      }),
    ).rejects.toSatisfy(refusedWith("unrestricted_profile_required"));
    await expect(api.deleteProfile({ params: { id: "profile-mara" } })).rejects.toSatisfy(
      refusedWith("unrestricted_profile_required"),
    );
    await expect(
      api.updateProfile({ params: { id: "profile-kids" }, body: { name: "Pip" } }),
    ).resolves.toMatchObject({ name: "Pip" });
  });

  it("a locked profile is its owner's: its PIN or the password, from any other profile or the gate", async () => {
    const api = mockApi(on("profile-mara"));
    const rename = (proof: object = {}) =>
      api.updateProfile({ params: { id: "profile-theo" }, body: { name: "Teddy", ...proof } });
    await expect(rename()).rejects.toSatisfy(refusedWith("profile_unlock_required"));
    await expect(rename({ currentPin: "0000" })).rejects.toSatisfy(
      refusedWith("profile_pin_invalid"),
    );
    await expect(rename({ currentPassword: "nope" })).rejects.toSatisfy(
      refusedWith("current_password_invalid"),
    );
    await expect(rename({ currentPin: "1234" })).resolves.toMatchObject({ name: "Teddy" });
    await expect(api.deleteProfile({ params: { id: "profile-theo" } })).rejects.toSatisfy(
      refusedWith("profile_unlock_required"),
    );
    await api.deleteProfile({
      params: { id: "profile-theo" },
      body: { currentPassword: "webflix-demo" },
    });
    expect((await api.listProfiles()).items.map((profile) => profile.name)).not.toContain("Teddy");

    // The session's own profile needs no unlock.
    const theo = mockApi(on("profile-theo"));
    await expect(
      theo.updateProfile({ params: { id: "profile-theo" }, body: { name: "Ted" } }),
    ).resolves.toMatchObject({ name: "Ted" });
  });

  it("loosening needs the password, even on the session's own profile; restricting does not", async () => {
    const api = mockApi(on("profile-mara"));
    await expect(
      api.updateProfile({ params: { id: "profile-mara" }, body: { pin: "4321" } }),
    ).rejects.toSatisfy(refusedWith("password_required"));
    await expect(
      api.updateProfile({ params: { id: "profile-kids" }, body: { isKids: false } }),
    ).rejects.toSatisfy(refusedWith("password_required"));
    await expect(
      api.updateProfile({ params: { id: "profile-mara" }, body: { maturityCeiling: "13+" } }),
    ).resolves.toMatchObject({ maturityCeiling: "13+" });
    await expect(
      api.updateProfile({
        params: { id: "profile-mara" },
        body: { maturityCeiling: "18+", currentPassword: "webflix-demo" },
      }),
    ).resolves.toMatchObject({ maturityCeiling: "18+" });
    // Turning Kids on caps the rating.
    await expect(
      api.updateProfile({ params: { id: "profile-mara" }, body: { isKids: true } }),
    ).resolves.toMatchObject({ isKids: true, maturityCeiling: "7+" });
  });
});

describe("the demo account", () => {
  const demo = () =>
    on("profile-mara", (state) => {
      state.account.isDemo = true;
    });

  it("is marked, and keeps its sign-in details, membership, devices and profiles", async () => {
    const api = mockApi(demo());
    const session = await api.getSession();
    expect(session.authenticated && session.account.isDemo).toBe(true);
    expect((await api.getAccount()).account.isDemo).toBe(true);
    for (const attempt of [
      () => api.changePlan({ body: { planId: "premium" } }),
      () => api.cancelMembership(),
      () => api.revokeDevice({ params: { id: "device-tv" } }),
      () => api.logoutAll(),
      () =>
        api.updateAccount({ body: { currentPassword: "webflix-demo", email: "new@example.com" } }),
      () => api.updateProfile({ params: { id: "profile-mara" }, body: { name: "Mum" } }),
      () => api.deleteProfile({ params: { id: "profile-kids" } }),
    ]) {
      await expect(attempt()).rejects.toSatisfy(refusedWith("demo_account_protected"));
    }
    await expect(
      api.updateProfile({
        params: { id: "profile-mara" },
        body: { settings: { autoplayPreviews: false } },
      }),
    ).resolves.toMatchObject({ settings: { autoplayPreviews: false } });
  });
});
