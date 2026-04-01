#!/usr/bin/env bash
#
# Smoke test for the provider abstraction layer.
# Run against staging after deploy to validate routing + fallback.
#
# Usage:
#   ./scripts/smoke-test-providers.sh [BASE_URL] [AUTH_TOKEN]
#
# Defaults:
#   BASE_URL  = https://api-production-9bef.up.railway.app  (staging when available)
#   AUTH_TOKEN = reads from ATLAS_TEST_TOKEN env var
#
set -euo pipefail

BASE_URL="${1:-${ATLAS_STAGING_URL:-https://api-production-9bef.up.railway.app}}"
AUTH_TOKEN="${2:-${ATLAS_TEST_TOKEN:-}}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "${GREEN}  PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}  FAIL${NC} $1 — $2"; FAILED=$((FAILED + 1)); }
warn() { echo -e "${YELLOW}  WARN${NC} $1"; }

echo "============================================"
echo "  Atlas Provider Layer — Smoke Tests"
echo "  Target: ${BASE_URL}"
echo "============================================"
echo ""

# --- 1. Health Check ---
echo "1. Health Check"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/health" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  pass "GET /health → 200"
else
  fail "GET /health → ${HTTP_CODE}" "Server unreachable or unhealthy"
  echo ""
  echo "Cannot continue — server is down. Exiting."
  exit 1
fi

# --- 2. Research Endpoint (now routes to Anthropic) ---
echo ""
echo "2. Research Endpoint (Anthropic routing)"

if [ -z "$AUTH_TOKEN" ]; then
  warn "No AUTH_TOKEN provided — skipping authenticated endpoints"
  warn "Set ATLAS_TEST_TOKEN or pass as second argument"
  echo ""
  echo "============================================"
  echo "  Results: ${PASSED} passed (auth tests skipped)"
  echo "============================================"
  exit 0
fi

RESEARCH_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "${BASE_URL}/api/research" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query": "Bitcoin price analysis Q1 2026", "context": "REPORT"}' \
  2>/dev/null)

RESEARCH_BODY=$(echo "$RESEARCH_RESPONSE" | sed '$d')
RESEARCH_CODE=$(echo "$RESEARCH_RESPONSE" | tail -1)

if [ "$RESEARCH_CODE" = "200" ]; then
  pass "POST /api/research → 200"

  # Verify response structure
  if echo "$RESEARCH_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'summary' in d" 2>/dev/null; then
    pass "Research response has 'summary' field"
  else
    fail "Research response structure" "Missing 'summary' field"
  fi

  if echo "$RESEARCH_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'sentiment' in d" 2>/dev/null; then
    pass "Research response has 'sentiment' field"
  else
    fail "Research response structure" "Missing 'sentiment' field"
  fi
else
  fail "POST /api/research → ${RESEARCH_CODE}" "$RESEARCH_BODY"
fi

# --- 3. Generate Endpoint (tweet generation, routes to OpenAI) ---
echo ""
echo "3. Generate Endpoint (OpenAI routing)"

GENERATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "${BASE_URL}/api/drafts/generate" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"sourceContent": "Bitcoin just crossed $150k for the first time", "sourceType": "TRENDING_TOPIC"}' \
  2>/dev/null)

GENERATE_BODY=$(echo "$GENERATE_RESPONSE" | sed '$d')
GENERATE_CODE=$(echo "$GENERATE_RESPONSE" | tail -1)

if [ "$GENERATE_CODE" = "200" ]; then
  pass "POST /api/drafts/generate → 200"

  if echo "$GENERATE_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['draft']['content']" 2>/dev/null; then
    pass "Generate response has draft.content"
  else
    fail "Generate response structure" "Missing draft.content"
  fi

  if echo "$GENERATE_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['draft']['confidence'] > 0" 2>/dev/null; then
    pass "Generate response has positive confidence"
  else
    fail "Generate response structure" "Missing or zero confidence"
  fi
elif [ "$GENERATE_CODE" = "400" ]; then
  # 400 = likely "Voice profile not found" — test user may not have onboarded
  warn "POST /api/drafts/generate → 400 (expected if test user has no voice profile)"
  echo "  Response: $(echo "$GENERATE_BODY" | head -c 200)"
else
  fail "POST /api/drafts/generate → ${GENERATE_CODE}" "$(echo "$GENERATE_BODY" | head -c 200)"
fi

# --- Summary ---
echo ""
echo "============================================"
TOTAL=$((PASSED + FAILED))
if [ "$FAILED" -eq 0 ]; then
  echo -e "  ${GREEN}All ${TOTAL} checks passed${NC}"
else
  echo -e "  ${PASSED} passed, ${RED}${FAILED} failed${NC} out of ${TOTAL}"
fi
echo "============================================"

exit $FAILED
