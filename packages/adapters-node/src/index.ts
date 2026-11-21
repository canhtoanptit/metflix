/**
 * @webflix/adapters-node: Node implementations of `@webflix/core` ports.
 *
 * - `@webflix/adapters-node`         filesystem BlobStore (dev), scrypt PasswordHasher
 * - `@webflix/adapters-node/s3`      S3-compatible BlobStore (k8s)
 * - `@webflix/adapters-node/valkey`  Valkey cache, rate limiter, stream gate, job queue (k8s)
 *
 * The infrastructure clients live behind subpaths so dev mode and tools that only need the
 * filesystem store never load them.
 */
export { createFsBlobStore, type FsBlobStoreOptions } from "./fs-blob-store.ts";
export { createScryptPasswordHasher, type ScryptOptions } from "./scrypt-password-hasher.ts";
