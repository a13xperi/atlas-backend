import { spawnSync } from "child_process";
import { resolve } from "path";

describe("seed scripts fail-fast when env vars are missing", () => {
  const repoRoot = resolve(__dirname, "../../../../..");

  const scripts = [
    {
      name: "prisma/seed.ts",
      path: resolve(repoRoot, "prisma/seed.ts"),
      envVar: "SEED_PASSWORD",
    },
    {
      name: "scripts/seed-demo.ts",
      path: resolve(repoRoot, "scripts/seed-demo.ts"),
      envVar: "DEMO_SEED_PASSWORD",
    },
    {
      name: "services/api/src/scripts/seed-alex.ts",
      path: resolve(repoRoot, "services/api/src/scripts/seed-alex.ts"),
      envVar: "ALEX_SEED_PASSWORD",
    },
    {
      name: "services/api/src/scripts/seed-anil.ts",
      path: resolve(repoRoot, "services/api/src/scripts/seed-anil.ts"),
      envVar: "ANIL_SEED_PASSWORD",
    },
  ];

  scripts.forEach(({ name, path, envVar }) => {
    it(`${name} exits non-zero and reports missing ${envVar}`, () => {
      const result = spawnSync("npx", ["tsx", path], {
        cwd: repoRoot,
        env: { PATH: process.env.PATH || "" },
        encoding: "utf-8",
      });

      expect(result.status).not.toBe(0);
      const output = (result.stderr ?? "") + (result.stdout ?? "");
      expect(output).toMatch(new RegExp(envVar));
      expect(output).toMatch(/required/);
    });
  });
});
