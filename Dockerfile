# ─── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only package files first (better layer caching)
COPY package.json ./

# Install production dependencies only
RUN npm install --omit=dev

# ─── Runtime stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Add non-root user for security
RUN addgroup -g 1001 -S cipherchat && \
    adduser -S cipherchat -u 1001

# Copy deps from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy server code
COPY package.json ./
COPY index.js ./

# Own the files
RUN chown -R cipherchat:cipherchat /app

USER cipherchat

# Expose WebSocket + HTTP port
EXPOSE 8080

# Health check — hits /health endpoint every 30s
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "index.js"]