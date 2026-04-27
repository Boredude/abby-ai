FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---------- runtime ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Pin Playwright's browser cache to a stable, root-owned path so it survives
# layer rebuilds and isn't inside /root (which differs between image variants).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Install Chromium + the system libraries it needs at runtime
# (libnss3, libxss1, fonts, etc.). `--with-deps` asks Playwright to apt-get
# the right packages for the current base image. We only install Chromium —
# Firefox/WebKit aren't used by the IG grid capture path.
RUN pnpm exec playwright install --with-deps chromium

COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle

EXPOSE 3000
CMD ["node", "dist/index.js"]
