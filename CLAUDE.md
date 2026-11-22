# Webflix

A Netflix-class streaming product built as a spike. One codebase, two required deployment modes: Kubernetes (Helm, kind locally) and Cloudflare serverless.

**Read `docs/BLUEPRINT.md` before doing anything.** It defines the architecture, the API surface, directory ownership, the UX standard and the rules for working in parallel with other contributors. Then read `docs/FOUNDATION.md`: workspace commands, the route table and typed client, the ports and their contract suites, and the code conventions. `README.md` shows how to run and verify each mode.

Essentials:

- pnpm workspace, packages scoped `@webflix/*`, TypeScript strict everywhere.
- Hexagonal: `packages/core`, `packages/http` and `packages/contracts` use Web-standard APIs only. Runtime specifics live in adapters and in `apps/api` (Node) and `apps/edge` (Cloudflare Worker).
- A feature is done only when it works in both required modes.
- Definition of done: `pnpm typecheck`, `pnpm lint`, `pnpm test` pass, and the behaviour was exercised for real.
- Do not run git commands that modify the working tree or history (`commit`, `stash`, `reset`, `checkout`, `clean`).
- Webflix is its own brand. Netflix is the UX reference only; never use its name, marks, fonts, artwork or copy.
