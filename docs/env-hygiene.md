# Env Hygiene

This repo ships an env hygiene gate to stop obvious dev-only URLs from leaking into production-facing changes. The CI workflow inspects added lines in pull requests and fails when it finds localhost, loopback, ngrok, Railway dev hosts, Vercel preview paths, or Delphi staging hostnames outside the approved exclusions for tests, docs, and README files.

Run the same check locally before deploy with:

```bash
bash scripts/env-hygiene-local.sh
```

If you need to bypass the CI gate for a specific pull request, add `[skip-env-hygiene]` to at least one commit message in that PR. Use that sparingly and only when the matched line is intentionally non-production.

The canonical production values do not live in git. Use the root-level [.env.production.example](/private/tmp/worktrees/codex-t4-env-hygiene-ci-033100/.env.production.example) as the schema, and pull the real `.env.production` from the 1Password item `Atlas Backend / Production / .env.production` in the `Delphi Digital` vault.
