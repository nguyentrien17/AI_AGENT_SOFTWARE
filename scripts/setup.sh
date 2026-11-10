#!/usr/bin/env sh
# Local setup for the AI Agent Software Platform (POSIX shells)
set -eu
cd "$(dirname "$0")/.."
node -e 'const [M]=process.versions.node.split(".").map(Number); if (M<22) { console.error("Node.js >= 22 required"); process.exit(1) }'
git --version >/dev/null
command -v docker >/dev/null 2>&1 || echo "WARNING: Docker not found: sandboxed execution (Phase 6+) unavailable."
npm install
npm run verify
echo "Setup complete. Start the API with: npm run dev:api"
