/**
 * Secret-shaped test values, assembled at runtime so that no source file in the repository
 * contains a literal that the secret scan (`secret-scan.test.ts`) would flag.
 */
const body = (seed: string, length = 24) =>
  seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

export const fake = {
  secretKey: ["sk", "test", body("51Ab3dEf9")].join("_"),
  sandboxKey: ["rkcs", "test", body("51Qx7Yz2K", 99)].join("_"),
  publishableKey: ["pk", "test", body("51Mn4Op8Q")].join("_"),
  liveKey: ["rk", "live", body("Zz09Yy87X")].join("_"),
  webhookSecret: ["whsec", body("a1B2c3D4e5", 32)].join("_"),
  piClientSecret: ["pi", "3AbP0q7xQm2LpRt90aBcDeF1", "secret", body("Xy12Zq34Wv", 25)].join("_"),
  setiClientSecret: ["seti", "1AbMn37xQm2LpRt9KmRVahoE", "secret", body("Tq8Rp3Mn1", 25)].join("_"),
  maskedKey: `${["rkcs", "test", "51"].join("_")}${"*".repeat(40)}Zx9q`,
  claimUrl: `https://dashboard.stripe.com/${["onboard", "sandbox"].join("_")}/${body("AbC123dEf456", 55)}`,
  oauthToken: ["oak", body("Qw3Er5Ty7U", 30)].join("_"),
};
