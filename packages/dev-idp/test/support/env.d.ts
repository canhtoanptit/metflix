// Set per Vitest project in vitest.config.ts.
declare module "vitest" {
  interface ProvidedContext {
    runtime: "node" | "workerd";
  }
}

export {};
