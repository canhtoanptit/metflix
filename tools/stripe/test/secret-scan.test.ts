import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/paths.ts";
import { findSecrets } from "../src/secrets.ts";

/**
 * Fails if a Stripe credential (API key, Stripe's masked key form, webhook signing secret, client
 * secret, CLI token, sandbox claim link) appears in any file git would commit: tracked files and
 * untracked files that are not ignored. Ignored files (.cache/stripe, .env, …) are where the
 * credentials are supposed to live. Read-only git only (`ls-files`).
 */
function candidateFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [...new Set(out.split("\0").filter(Boolean))];
}

describe("repository secret scan", () => {
  it("finds no Stripe secret in any committable file", () => {
    const findings: string[] = [];
    let scanned = 0;
    for (const file of candidateFiles()) {
      const path = join(REPO_ROOT, file);
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue; // deleted in the working tree but still in the index
      }
      if (size > 8 * 1024 * 1024) continue;
      const buffer = readFileSync(path);
      if (buffer.subarray(0, 8000).includes(0)) continue; // binary
      scanned++;
      for (const finding of findSecrets(buffer.toString("utf8"))) {
        findings.push(`${file}:${finding.line} ${finding.kind} (${finding.preview})`);
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(findings).toEqual([]);
  });

  it("keeps the credential files out of git", () => {
    const ignored = execFileSync(
      "git",
      [
        "check-ignore",
        ".cache/stripe/sandbox.json",
        ".cache/stripe/stripe.env",
        ".cache/stripe/config/stripe/config.toml",
        ".cache/stripe/listen/dev.log",
        ".cache/stripe/runs/x/raw.json",
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(ignored.trim().split("\n")).toHaveLength(5);
  });
});
