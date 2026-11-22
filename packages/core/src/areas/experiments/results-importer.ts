import type { JsonValue } from "@webflix/contracts";
import { sha256Hex } from "../../encoding.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import { type Logger, serializeError } from "../../ports/logger.ts";

/**
 * The experiment results importer (milestone 2 §8.1): the pipeline's `analyse-experiments`
 * writes one result per experiment under `experiments/results/r={run}/` and the pointer
 * `experiments/results/current.json` last (services/recs/README.md, "Experiment results").
 * This reads the pointer, verifies each file it names (byte count and SHA-256), and saves each
 * report under its experiment and analysis time. A run directory the pointer does not name is
 * never read; a key the product does not know is skipped; importing the same pointer again
 * writes nothing. Portable: the Node command line, the job in either runtime.
 */

export const RESULTS_POINTER_KEY = "experiments/results/current.json";
const POINTER_FORMAT = "webflix.experiment-results-pointer";
const RESULT_FORMAT = "webflix.experiment-result";
const SUPPORTED_MAJOR = 1;
const RUN_PATTERN = /^\d{8}-\d{6}-\d{3}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class ExperimentResultsImportError extends Error {
  override readonly name = "ExperimentResultsImportError";
}

/** Where the results go: the experiments area's own operations. */
export interface ExperimentResultsTarget {
  /** Whether the product knows this experiment. */
  knows(key: string): Promise<boolean>;
  /** The newest stored analysis time of an experiment, or null. */
  latestComputedAt(key: string): Promise<number | null>;
  save(key: string, report: JsonValue, computedAt: number): Promise<void>;
}

export interface ExperimentResultsImportResult {
  /** `none`: nothing published yet. */
  status: "imported" | "none";
  run: string | null;
  /** Saved now. */
  imported: string[];
  /** Already stored with this analysis time: nothing written. */
  unchanged: string[];
  /** Not imported, with the reason (unknown experiment, failed verification). */
  skipped: { key: string; reason: string }[];
}

interface PointerEntry {
  key: string;
  path: string;
  bytes: number;
  sha256: string;
}

/** Imports the results the pointer names. Throws only when the pointer itself is unusable. */
export async function importExperimentResults(options: {
  blobs: BlobStore;
  target: ExperimentResultsTarget;
  logger: Logger;
}): Promise<ExperimentResultsImportResult> {
  const { blobs, target, logger } = options;
  const pointerBytes = await readBlob(blobs, RESULTS_POINTER_KEY);
  if (!pointerBytes) {
    return { status: "none", run: null, imported: [], unchanged: [], skipped: [] };
  }
  const pointer = parseObject(pointerBytes, RESULTS_POINTER_KEY);
  if (pointer.format !== POINTER_FORMAT || pointer.formatVersion !== SUPPORTED_MAJOR) {
    throw new ExperimentResultsImportError(
      `${RESULTS_POINTER_KEY}: not a ${POINTER_FORMAT} of major version ${SUPPORTED_MAJOR}`,
    );
  }
  const run = pointer.run;
  if (typeof run !== "string" || !RUN_PATTERN.test(run) || !Array.isArray(pointer.results)) {
    throw new ExperimentResultsImportError(`${RESULTS_POINTER_KEY}: malformed run or results`);
  }
  const directory = `experiments/results/r=${run}/`;
  const result: ExperimentResultsImportResult = {
    status: "imported",
    run,
    imported: [],
    unchanged: [],
    skipped: [],
  };
  for (const raw of pointer.results) {
    const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<PointerEntry>;
    const key = typeof entry.key === "string" ? entry.key : "(unnamed)";
    try {
      const document = await readResult(blobs, directory, entry);
      if (!(await target.knows(key))) {
        result.skipped.push({ key, reason: "unknown experiment" });
        continue;
      }
      if ((await target.latestComputedAt(key)) === document.computedAt) {
        result.unchanged.push(key);
        continue;
      }
      await target.save(key, document.report, document.computedAt);
      result.imported.push(key);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error("experiments.result_rejected", { key, run, error: serializeError(error) });
      result.skipped.push({ key, reason });
    }
  }
  logger.info("experiments.results_imported", {
    run,
    imported: result.imported.join(","),
    unchanged: result.unchanged.join(","),
    skipped: result.skipped.map((entry) => entry.key).join(","),
  });
  return result;
}

/** One result file, verified against its pointer entry and its own format. */
async function readResult(
  blobs: BlobStore,
  directory: string,
  entry: Partial<PointerEntry>,
): Promise<{ report: JsonValue; computedAt: number }> {
  const { key, path, bytes, sha256 } = entry;
  if (
    typeof key !== "string" ||
    !KEY_PATTERN.test(key) ||
    typeof path !== "string" ||
    !Number.isInteger(bytes) ||
    typeof sha256 !== "string"
  ) {
    throw new ExperimentResultsImportError("malformed pointer entry");
  }
  // Only the run the pointer names: anything else is incomplete or old.
  if (!path.startsWith(directory) || path.split("/").includes("..")) {
    throw new ExperimentResultsImportError(`${path} is outside ${directory}`);
  }
  const content = await readBlob(blobs, path);
  if (!content) throw new ExperimentResultsImportError(`${path} is missing`);
  if (content.byteLength !== bytes) {
    throw new ExperimentResultsImportError(
      `${path}: ${content.byteLength} bytes, the pointer says ${bytes}`,
    );
  }
  if ((await sha256Hex(content)) !== sha256.toLowerCase()) {
    throw new ExperimentResultsImportError(`${path}: SHA-256 does not match the pointer`);
  }
  const document = parseObject(content, path);
  if (document.format !== RESULT_FORMAT || document.formatVersion !== SUPPORTED_MAJOR) {
    throw new ExperimentResultsImportError(
      `${path}: not a ${RESULT_FORMAT} of major version ${SUPPORTED_MAJOR}`,
    );
  }
  if (document.key !== key) {
    throw new ExperimentResultsImportError(`${path}: holds ${String(document.key)}, not ${key}`);
  }
  if (typeof document.computedAt !== "string" || !ISO_MS.test(document.computedAt)) {
    throw new ExperimentResultsImportError(`${path}: computedAt is not an ISO instant`);
  }
  if (typeof document.report !== "object" || document.report === null) {
    throw new ExperimentResultsImportError(`${path}: no report`);
  }
  return { report: document.report as JsonValue, computedAt: Date.parse(document.computedAt) };
}

async function readBlob(blobs: BlobStore, key: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const object = await blobs.get(key);
  if (!object) return null;
  return new Uint8Array(await new Response(object.body).arrayBuffer());
}

function parseObject(bytes: Uint8Array, key: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ExperimentResultsImportError(`${key}: not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExperimentResultsImportError(`${key}: not a JSON object`);
  }
  return value as Record<string, unknown>;
}
