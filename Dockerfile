# Sandbox container image for claude-swarm agent.
# Base image includes Node.js 20 and the sandbox runtime.
# Agent code (dist/) must be built before deploying: npm run build

FROM docker.io/cloudflare/sandbox:0.7.0

WORKDIR /app

# Install agent runtime dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev 2>/dev/null || npm install --production

# Copy compiled agent code (tsc output)
COPY dist/ ./dist/

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN adduser --disabled-password --gecos "" agent && chown -R agent:agent /app
USER agent
