import { STAFF_CLIENT_ID } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import {
  StaffTokenError,
  type StaffTokenFailureReason,
  type StaffVerifier,
} from "../ports/staff-verifier.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

/** What a test asks the staff issuer to mint (Keycloak's claim shape). */
export interface StaffTokenRequest {
  subject: string;
  name?: string;
  email?: string;
  /** `resource_access.<client>.roles`. */
  clientRoles?: Record<string, string[]>;
  realmRoles?: string[];
  /** Default 300; negative: already expired. */
  expiresInSec?: number;
  /** `nbf`/`iat` this many seconds from now. */
  notBeforeSec?: number;
  audience?: string | string[];
  issuer?: string;
  tokenType?: "access" | "id";
}

export interface StaffVerifierHarness extends HarnessBase {
  verifier: StaffVerifier;
  /**
   * Mints a token from the verifier's issuer (memory: `MemoryStaffVerifier.mint`; the JWKS
   * adapter: the development issuer's `mintTokens` with a persona carrying these roles).
   */
  mint(request: StaffTokenRequest): Promise<string>;
  /** A token the issuer never signed (another key), with otherwise valid claims. */
  forge(request: StaffTokenRequest): Promise<string>;
}

/** Contract every `StaffVerifier` adapter must pass. */
export function describeStaffVerifierContract(
  name: string,
  factory: HarnessFactory<StaffVerifierHarness>,
): void {
  describe(`StaffVerifier contract: ${name}`, () => {
    const h = useHarness(factory);
    const roles = (...names: string[]) => ({ [STAFF_CLIENT_ID]: names });

    async function rejection(token: string): Promise<StaffTokenFailureReason> {
      const error = await h()
        .verifier.verify(token)
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error, "expected the token to be refused").toBeInstanceOf(StaffTokenError);
      return (error as StaffTokenError).reason;
    }

    it("accepts a valid access token and maps the Webflix client's roles", async () => {
      const token = await h().mint({
        subject: "staff-1",
        name: "Ada Support",
        email: "ada@staff.test",
        clientRoles: roles("support", "billing"),
      });
      const identity = await h().verifier.verify(token);
      expect(identity.subject).toBe("staff-1");
      expect(identity.roles).toEqual(["support", "billing"]);
      expect(Number.isInteger(identity.expiresAt) && identity.expiresAt > 0).toBe(true);
    });

    it("ignores realm roles, other clients' roles and unknown role names", async () => {
      const token = await h().mint({
        subject: "staff-2",
        realmRoles: ["admin", "offline_access"],
        clientRoles: {
          ...roles("content", "superuser"),
          "other-app": ["admin"],
          account: ["admin"],
        },
      });
      expect((await h().verifier.verify(token)).roles).toEqual(["content"]);
    });

    it("verifies a staff member without a Webflix role with no roles", async () => {
      const token = await h().mint({ subject: "staff-3", clientRoles: { "other-app": ["admin"] } });
      expect((await h().verifier.verify(token)).roles).toEqual([]);
    });

    it("refuses an expired token", async () => {
      const token = await h().mint({
        subject: "s",
        clientRoles: roles("admin"),
        expiresInSec: -600,
      });
      expect(await rejection(token)).toBe("expired");
    });

    it("refuses a token that is not valid yet", async () => {
      const token = await h().mint({
        subject: "s",
        clientRoles: roles("admin"),
        notBeforeSec: 900,
      });
      expect(await rejection(token)).toBe("not_yet_valid");
    });

    it("refuses a token for another audience", async () => {
      const token = await h().mint({
        subject: "s",
        clientRoles: roles("admin"),
        audience: ["account", "some-other-api"],
      });
      expect(await rejection(token)).toBe("audience");
    });

    it("refuses a token from another issuer", async () => {
      const token = await h().mint({
        subject: "s",
        clientRoles: roles("admin"),
        issuer: "https://elsewhere.test/realms/staff",
      });
      expect(["issuer", "signature"]).toContain(await rejection(token));
    });

    it("refuses an ID token presented as an access token", async () => {
      const token = await h().mint({ subject: "s", clientRoles: roles("admin"), tokenType: "id" });
      expect(await rejection(token)).toBe("token_type");
    });

    it("refuses a token the issuer did not sign, and a tampered one", async () => {
      const forged = await h().forge({ subject: "s", clientRoles: roles("admin") });
      expect(await rejection(forged)).toBe("signature");
      const genuine = await h().mint({ subject: "s", clientRoles: roles("support") });
      const [head, body, signature = ""] = genuine.split(".");
      // Change a character in the middle of the signature: its last character may carry only
      // padding bits, which a lenient base64url decoder ignores.
      const middle = Math.floor(signature.length / 2);
      const swapped = signature[middle] === "A" ? "Q" : "A";
      const tampered = `${head}.${body}.${signature.slice(0, middle)}${swapped}${signature.slice(middle + 1)}`;
      expect(await rejection(tampered)).toBe("signature");
    });

    it("refuses garbage as malformed", async () => {
      for (const token of ["", "not-a-token", "a.b", "a.b.c.d"]) {
        expect(["malformed", "signature"]).toContain(await rejection(token));
      }
    });
  });
}
