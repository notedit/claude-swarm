#!/usr/bin/env bash
# deploy.sh — Automated deployment of claude-swarm to Fly.io
#
# Prerequisites: flyctl, node, npm
# Run from the project root: bash example/fly-deploy/deploy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Check prerequisites ─────────────────────────────────────────────────────

command -v flyctl >/dev/null 2>&1 || error "flyctl not found. Install: https://fly.io/docs/flyctl/install/"
command -v node   >/dev/null 2>&1 || error "node not found. Install Node.js 20+"
command -v npm    >/dev/null 2>&1 || error "npm not found"

info "Prerequisites OK"

# ── Check environment ────────────────────────────────────────────────────────

if [ -z "${FLY_API_TOKEN:-}" ]; then
  warn "FLY_API_TOKEN not set. You can set it or use 'flyctl auth login'."
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  warn "ANTHROPIC_API_KEY not set. Agents will fail without it."
fi

# ── Step 1: Build TypeScript ─────────────────────────────────────────────────

info "Step 1: Building TypeScript..."
cd "$PROJECT_ROOT"
npm install
npm run build
info "Build complete"

# ── Step 2: Create Fly apps ─────────────────────────────────────────────────

AGENT_APP="${FLY_APP_NAME:-claude-agent-app}"
ORCH_APP="claude-orchestrator"

info "Step 2: Creating Fly apps..."

if flyctl apps list 2>/dev/null | grep -q "$AGENT_APP"; then
  info "Agent app '$AGENT_APP' already exists"
else
  flyctl apps create "$AGENT_APP" --machines || warn "Could not create agent app (may already exist)"
fi

if flyctl apps list 2>/dev/null | grep -q "$ORCH_APP"; then
  info "Orchestrator app '$ORCH_APP' already exists"
else
  flyctl apps create "$ORCH_APP" --machines || warn "Could not create orchestrator app (may already exist)"
fi

# ── Step 3: Deploy agent image ───────────────────────────────────────────────

info "Step 3: Building and pushing agent image..."
flyctl deploy -c "$SCRIPT_DIR/fly.agent.toml" --image-only --remote-only
info "Agent image pushed"

# ── Step 4: Deploy orchestrator ──────────────────────────────────────────────

info "Step 4: Deploying orchestrator..."
flyctl deploy -c "$SCRIPT_DIR/fly.orchestrator.toml" --remote-only
info "Orchestrator deployed"

# ── Step 5: Set secrets ──────────────────────────────────────────────────────

info "Step 5: Setting secrets..."

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  flyctl secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -a "$ORCH_APP" || true
fi

if [ -n "${REDIS_URL:-}" ]; then
  flyctl secrets set REDIS_URL="$REDIS_URL" -a "$ORCH_APP" || true
fi

if [ -n "${FLY_API_TOKEN:-}" ]; then
  flyctl secrets set FLY_API_TOKEN="$FLY_API_TOKEN" -a "$ORCH_APP" || true
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
info "Deployment complete!"
echo ""
echo "  Orchestrator URL: https://$ORCH_APP.fly.dev"
echo ""
echo "  Test with:"
echo "    curl -X POST https://$ORCH_APP.fly.dev/sessions \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"prompt\": \"Hello, Claude!\"}'"
echo ""
echo "    curl https://$ORCH_APP.fly.dev/sessions/<session_id>"
echo ""
echo "    curl https://$ORCH_APP.fly.dev/health"
echo ""
