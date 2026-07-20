# syntax=docker/dockerfile:1

# --- build stage: full deps + vite build → dist/ (client assets + the server fetch handler) ---
FROM node:24-slim AS build
WORKDIR /app
# pnpm 11 aborts an install on any unreviewed dependency build script (strictDepBuilds). If a dep
# ships a build script this image doesn't need (e.g. protobufjs via the OTel exporter), relax the
# gate for every pnpm step in this stage rather than run it. Review which scripts this skips for
# YOUR dependency set before trusting it.
ENV PNPM_CONFIG_STRICT_DEP_BUILDS=false
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# --- runtime stage: a NORMAL Node app, NOT a self-contained bundle ---
# Keep production node_modules so deps stay REAL runtime imports (matches the other packages'
# images). server.ts uses srvx to run the fetch handler + serve dist/client. Node 24 runs the .ts
# files directly (native type stripping) — no ts-node/tsx.
# No tracer: this is a single-user app on the owner's machine with no collector to export to (a
# deliberate deviation from the source skill's OTel/Datadog choice — see the design spec).
FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3002
ENV HOST=0.0.0.0
ENV PNPM_CONFIG_STRICT_DEP_BUILDS=false
WORKDIR /app
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY server.ts ./
EXPOSE 3002
USER node
CMD ["node", "server.ts"]
