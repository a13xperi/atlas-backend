#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

red=$'\033[31m'
green=$'\033[32m'
yellow=$'\033[33m'
blue=$'\033[34m'
reset=$'\033[0m'

pattern_parts=(
  'http://local''host'
  '127\.0\.0''\.1'
  '\.ng''rok\.'
  '-dev\.up\.railway\.''app'
  'vercel\.app/_pre''view'
  'staging\.delphi''digital'
)
env_hygiene_regex="$(IFS='|'; echo "${pattern_parts[*]}")"

approved_baseline_pattern='^(\./)?\.env\.example:(3|43|45):|^(\./)?services/api/src/lib/config\.ts:9:'

raw_matches_file="$(mktemp)"
filtered_matches_file="$(mktemp)"
trap 'rm -f "$raw_matches_file" "$filtered_matches_file"' EXIT

printf '%sEnv hygiene scan%s\n' "$blue" "$reset"
printf 'Repo: %s\n' "$repo_root"

rg \
  --hidden \
  --line-number \
  --with-filename \
  --color=never \
  --glob '!.git/**' \
  --glob '!**/__tests__/**' \
  --glob '!**/*.test.ts' \
  --glob '!**/*.spec.ts' \
  --glob '!docs/**' \
  --glob '!**/README.md' \
  "$env_hygiene_regex" \
  . > "$raw_matches_file" || true

grep -Ev "$approved_baseline_pattern" "$raw_matches_file" > "$filtered_matches_file" || true

approved_baseline_hits=0
if [ -s "$raw_matches_file" ]; then
  approved_baseline_hits="$(grep -Ec "$approved_baseline_pattern" "$raw_matches_file" || true)"
fi

if [ -s "$filtered_matches_file" ]; then
  offending_line_count="$(wc -l < "$filtered_matches_file" | tr -d ' ')"
  offending_file_count="$(cut -d: -f1 "$filtered_matches_file" | sort -u | wc -l | tr -d ' ')"

  printf '%sBlocked dev URLs found:%s\n' "$red" "$reset"
  while IFS= read -r line; do
    printf '%s%s%s\n' "$yellow" "$line" "$reset"
  done < "$filtered_matches_file"

  printf '%sSummary:%s %s offending line(s) across %s file(s)%s\n' \
    "$red" "$reset" "$offending_line_count" "$offending_file_count" \
    "$([ "$approved_baseline_hits" -gt 0 ] && printf '; %s approved baseline match(es) ignored' "$approved_baseline_hits")"
  exit 1
fi

printf '%sSummary:%s 0 offending lines%s\n' \
  "$green" "$reset" \
  "$([ "$approved_baseline_hits" -gt 0 ] && printf '; %s approved baseline match(es) ignored' "$approved_baseline_hits")"
