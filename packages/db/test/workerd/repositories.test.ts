/** The repository contract on D1, inside workerd (migrated by the generated SQL files). */
import { describeRepositoryContract } from "@webflix/core/testing";
import { createRepositories } from "../../src/repositories/index.ts";
import { freshD1Database } from "./setup.ts";

describeRepositoryContract("d1", async () => ({
  repos: createRepositories(await freshD1Database()),
}));
