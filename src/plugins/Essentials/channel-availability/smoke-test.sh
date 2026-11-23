#!/usr/bin/env bash
# Smoke test for the channel-availability shop API against a RUNNING dev server.
# Exercises the real DB + postal joins (what unit tests can't). Requires the
# server restarted with the latest schema and the seeded brand/channel/postal data.
#
# Usage:  bash src/plugins/Essentials/channel-availability/smoke-test.sh
# Exit code 0 = all pass, 1 = at least one failure.
set -uo pipefail
cd "$(dirname "$0")/../../../.." || exit 1

PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-80}
API="http://localhost:${PORT}/shop-api"
PASS=0; FAIL=0

# gql <token> <query> → prints JSON response
gql() {
  curl -s "$API" -H 'Content-Type: application/json' -H "vendure-token: $1" -d "{\"query\":\"$2\"}"
}

# check <name> <jq-filter> <expected> <json>
check() {
  local name="$1" filter="$2" expected="$3" json="$4"
  local actual
  actual=$(echo "$json" | jq -rc "$filter" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $name"; PASS=$((PASS+1))
  else
    echo "  FAIL  $name  (expected: $expected | got: $actual)"; FAIL=$((FAIL+1))
  fi
}

echo "== channel-availability smoke test → $API =="

# 1. Kaaikani drill, matching pincode → exactly Madurai + its token
R=$(gql ind-madurai 'query{brandChannels(sellerId:2,postalCode:\"625001\"){code token}}')
check "brandChannels Kaaikani/625001 → 1 channel" '.data.brandChannels|length' '1' "$R"
check "brandChannels Kaaikani/625001 → Madurai token" '.data.brandChannels[0].token' 'ind-madurai' "$R"

# 2. Kaaikani drill, unserved pincode → not-serviceable error
R=$(gql ind-madurai 'query{brandChannels(sellerId:2,postalCode:\"999999\"){code}}')
check "brandChannels unserved pincode → USER_INPUT_ERROR" '.errors[0].extensions.code' 'USER_INPUT_ERROR' "$R"

# 3. South Mithai, country IN → India channel only (no International)
R=$(gql ind-madurai 'query{brandChannels(sellerId:3,postalCode:\"625001\",country:\"IN\"){type}}')
check "brandChannels SM country:IN → all non-International" '[.data.brandChannels[].type|ascii_downcase|contains("international")]|any|not' 'true' "$R"

# 4. South Mithai, no country → both regions (India + International) for the picker
R=$(gql ind-madurai 'query{brandChannels(sellerId:3,postalCode:\"625001\"){type}}')
check "brandChannels SM no country → >=2 channels (picker)" '(.data.brandChannels|length)>=2' 'true' "$R"

# 5. brandStorefronts pincode-aware: Sip N Nourish (Coimbatore-only) unavailable for Madurai
R=$(gql ind-madurai 'query{brandStorefronts(postalCode:\"625001\"){seller{name} isAvailable}}')
check "brandStorefronts 625001 → Sip N Nourish isAvailable=false" '[.data.brandStorefronts[]|select(.seller.name|test("Sip";"i")).isAvailable]|first' 'false' "$R"
check "brandStorefronts 625001 → Kaaikani isAvailable=true" '[.data.brandStorefronts[]|select(.seller.name|test("Kaaikani";"i")).isAvailable]|first' 'true' "$R"

# 6. Deprecated getAvailableChannels still works (returns a list, does not error)
R=$(gql ind-madurai 'query{getAvailableChannels(postalCode:\"625001\"){code}}')
check "getAvailableChannels (deprecated) still returns a list" '(.data.getAvailableChannels|type)' 'array' "$R"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
