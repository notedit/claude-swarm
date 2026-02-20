# Sandbox container image for claude-swarm agent.
# Base image includes Node.js 20 and the sandbox runtime.
# Agent code (dist/) must be built before deploying: npm run build

FROM docker.io/cloudflare/sandbox:latest

WORKDIR /app

# Install agent runtime dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev 2>/dev/null || npm install --production

# Copy compiled agent code (tsc output)
COPY dist/ ./dist/
