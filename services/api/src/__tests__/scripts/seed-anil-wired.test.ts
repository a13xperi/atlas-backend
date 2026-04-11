import fs from "fs";
import path from "path";

/**
 * Regression guard for atlas-backend #3948 — "Seed Anil account + voice
 * profile + demo data". The canonical seed script lives at
 * `scripts/seed-anil.ts` (not `services/api/src/scripts/seed-anil.ts`,
 * which is an older duplicate that is not imported anywhere). It must
 * be wired into `package.json` as `npm run seed:anil` so ops can
 * repopulate the Wednesday Apr 14 Anil demo in one command rather than
 * remembering the full `npx tsx` path.
 *
 * This test fails loud if the entry is deleted or retargeted to the
 * wrong file. Deliberately light — it doesn't execute the script
 * (that would hit a real database) and doesn't duplicate the type
 * checks that live in prisma + tsconfig.
 */

// __dirname = services/api/src/__tests__/scripts
// repo root  = ../../../../../  (5 levels up)
const REPO_ROOT = path.resolve(__dirname, "../../../../../");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const SEED_ANIL_SCRIPT = path.join(REPO_ROOT, "scripts/seed-anil.ts");

describe("seed:anil — npm script wiring (atlas-backend #3948)", () => {
  it("repo root resolves to a directory that contains package.json", () => {
    // Sanity-check the path arithmetic above. If this fails, the other
    // assertions would produce confusing "file not found" errors.
    expect(fs.existsSync(PACKAGE_JSON)).toBe(true);
  });

  it("defines a `seed:anil` entry in package.json scripts", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf-8"));
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts["seed:anil"]).toBeDefined();
  });

  it("the `seed:anil` entry points at scripts/seed-anil.ts (not the old duplicate)", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf-8"));
    const cmd: string = pkg.scripts["seed:anil"];
    // Must target the canonical root-level script. The old duplicate at
    // services/api/src/scripts/seed-anil.ts is dead code and we don't
    // want ops pointing at it from package.json.
    expect(cmd).toMatch(/scripts\/seed-anil\.ts/);
    expect(cmd).not.toMatch(/services\/api\/src\/scripts\/seed-anil\.ts/);
    // tsx is the expected runtime — ts-node is slow and has a different
    // resolver. Keep this assertion strict so a well-meaning swap back
    // to ts-node doesn't slip through.
    expect(cmd).toMatch(/npx\s+tsx/);
  });

  it("the target file exists and looks like the demo-ready script", () => {
    expect(fs.existsSync(SEED_ANIL_SCRIPT)).toBe(true);
    const contents = fs.readFileSync(SEED_ANIL_SCRIPT, "utf-8");
    // Header sentinel from scripts/seed-anil.ts — if someone rewrites
    // the file from scratch this assertion will force them to update
    // the expected shape intentionally.
    expect(contents).toMatch(/Seed \/ Repair Anil Demo Account/);
    // Contract with the dispatch workflow — the script must be
    // idempotent. Every version of this file so far has started with a
    // "safe to run multiple times" promise; keep that invariant.
    expect(contents.toLowerCase()).toMatch(/idempotent|safe to run multiple times/);
  });
});
