# Wave 7: all-in-one demo/preview image.
#  - external DATABASE_URL at runtime → production behavior identical to the
#    old slim image (see Dockerfile.server; entrypoint execs `npm start` only)
#  - no DATABASE_URL → self-contained demo: embedded MariaDB + MQTT broker +
#    device simulators + demo seed (scripts/demo-entrypoint.sh)
FROM node:20-alpine

RUN apk add --no-cache mariadb mariadb-client bash

WORKDIR /app

# NODE_ENV is not set yet here, so npm ci installs devDependencies too —
# drizzle-kit (build-time schema snapshot) and tsx (runtime seed/simulator
# scripts in demo mode) both come from devDependencies.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Demo-mode schema snapshot: full CREATE TABLE set generated from the CURRENT
# db/schema.ts (includes everything migrations 0014-0020 added). Never rely on
# db/migrations/*.sql — those are gitignored and may be absent from a platform
# snapshot. drizzle.demo.config.ts needs no DATABASE_URL (none exists at build
# time) and db/demo-schema is dockerignored, so the out dir is always fresh
# and `generate` always emits a full snapshot, never a diff.
RUN npx drizzle-kit generate --config drizzle.demo.config.ts

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bash", "scripts/demo-entrypoint.sh"]
