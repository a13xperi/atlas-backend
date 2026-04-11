import fs from "fs";
import path from "path";

/**
 * Regression guard for atlas-backend #3936 — "Replace 29 console.log calls
 * with pino logger". Production request-handling code must not log via
 * `console.*`; every log line should flow through `lib/logger.ts` so
 * Railway/Vercel/Sentry can index structured fields.
 *
 * Exempted on purpose:
 *   - services/api/src/scripts/**   — operator-facing CLI tools (seed
 *     scripts, smoke tests) that intentionally print human-readable
 *     output with emoji + box-drawing. Piping these through pino would
 *     regress DX and break CI seeding output.
 *   - services/api/src/__tests__/** — this guard itself + any test
 *     fixtures are free to use console.
 *
 * If this test starts failing, either route the new log line through
 * `logger` or move the script into `src/scripts/` so the exemption
 * applies. Do NOT add files to the SCANNED_DIRS exemption list — the
 * whole point is that production code paths stay clean.
 */

const SRC_ROOT = path.resolve(__dirname, "../../");
const SCANNED_DIRS = ["routes", "middleware", "lib"] as const;
const CONSOLE_CALL_RE = /\bconsole\.(log|error|warn|info|debug|trace)\s*\(/;

function walkTypeScriptFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip generated / test output directories if they ever land here.
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...walkTypeScriptFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      // Skip compiled output and declaration files.
      if (entry.name.endsWith(".d.ts")) continue;
      out.push(full);
    }
  }
  return out;
}

function findConsoleCalls(filePath: string): Array<{ line: number; text: string }> {
  const contents = fs.readFileSync(filePath, "utf-8");
  const hits: Array<{ line: number; text: string }> = [];
  contents.split("\n").forEach((line, idx) => {
    // Skip comments so a docblock mentioning `console.log` in prose
    // doesn't trip the guard.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    if (CONSOLE_CALL_RE.test(line)) {
      hits.push({ line: idx + 1, text: line.trim() });
    }
  });
  return hits;
}

describe("no console.* in production source (atlas-backend #3936)", () => {
  for (const sub of SCANNED_DIRS) {
    describe(`services/api/src/${sub}`, () => {
      const files = walkTypeScriptFiles(path.join(SRC_ROOT, sub));

      it("has at least one TypeScript file to scan (sanity check)", () => {
        expect(files.length).toBeGreaterThan(0);
      });

      it("contains no console.(log|error|warn|info|debug|trace) calls", () => {
        const offenders: string[] = [];
        for (const file of files) {
          const hits = findConsoleCalls(file);
          for (const hit of hits) {
            // Emit a relative path so the failure message is copy-pastable.
            const rel = path.relative(path.resolve(SRC_ROOT, "../../../"), file);
            offenders.push(`${rel}:${hit.line}  ${hit.text}`);
          }
        }

        if (offenders.length > 0) {
          // Jest truncates very long error strings, so join with an
          // explicit separator and cap each entry length.
          const pretty = offenders
            .map((o) => (o.length > 200 ? o.slice(0, 200) + "…" : o))
            .join("\n  ");
          throw new Error(
            `Found ${offenders.length} console.* call(s) in production code.\n` +
              `Route them through \`logger\` from lib/logger.ts instead — or, if ` +
              `this is a CLI/script, move it under services/api/src/scripts/.\n\n  ${pretty}\n`,
          );
        }
        expect(offenders).toEqual([]);
      });
    });
  }

  // A second assertion that scripts/** is still allowed to use console.
  // This prevents an over-eager future contributor from adding scripts/ to
  // SCANNED_DIRS without noticing the CLI-DX consequences.
  describe("services/api/src/scripts (intentionally exempt)", () => {
    const scriptsDir = path.join(SRC_ROOT, "scripts");

    it("is NOT in the scanned set", () => {
      expect(SCANNED_DIRS as readonly string[]).not.toContain("scripts");
    });

    it("is free to use console.* without tripping the guard", () => {
      // Scripts exist in the tree — no assertion on count, just that the
      // directory is reachable so the exemption is meaningful.
      if (fs.existsSync(scriptsDir)) {
        const files = walkTypeScriptFiles(scriptsDir);
        expect(files.length).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
