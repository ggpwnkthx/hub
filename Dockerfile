# syntax=docker/dockerfile:1

# The version of the runtime and the revision of the build are labels of the
# image: an operator has to know what is running without reading the logs.
#
# The base image is pinned by digest: a tag is a name that moves, and the
# image of a release has to be the image that was built and scanned.
ARG BUN_VERSION=1.4.3
ARG BUN_DIGEST=sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373
ARG VERSION=0.1.0
ARG REVISION=unknown

# ---------------------------------------------------------------- dependencies
#
# The dependencies of the service alone. The development dependencies (the
# types of the tests) are not part of the image of the service.
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_DIGEST} AS runtime-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && \
    rm -rf /root/.bun/install/cache

# ------------------------------------------------------------------- runtime
#
# The production image contains the service and nothing else. There is no
# fixture, no development account and no static policy in it.
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_DIGEST} AS runtime
WORKDIR /app

ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.title="hub" \
      org.opencontainers.image.description="An OpenID Connect broker: it authenticates a caller against the provider of a tenant and answers the decisions of a gateway." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="https://github.com/ggpwnkthx/hub" \
      org.opencontainers.image.licenses="MIT"

ENV HUB_ENVIRONMENT=production \
    HUB_HOST=0.0.0.0 \
    HUB_PORT=8081

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

# The service runs as a user that is not root: a container that is root on
# the host of the container is root on the host.
USER bun
EXPOSE 8081

# The service writes nothing: the logs go to the standard output and the
# file system of the container can be read-only.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8081/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["bun", "run"]
CMD ["src/main.ts"]
