# Catio web-server (Option B) — multi-stage image.
#   stage 1 (node)  : build the frontend bundle → dist/
#   stage 2 (rust)  : build the `catio-server` binary (reuses catio_lib)
#   stage 3 (slim)  : runtime — server binary + dist, served over HTTP on :8787
#
# Run: docker run -d -p 8787:8787 -v catio-data:/app/data catio-server
#
# NOTE: catio_lib depends on `tauri`, so the builder needs the Tauri/WebKit system libs and
# the runtime keeps their shared objects — even though the headless server never opens a
# webview (it links them transitively). Shrinking this (feature-gating Tauri out of the
# server build) is a Future optimization, intentionally out of scope for Phase 1.
#
# KNOWN GAP (M1): JDBC engines (Oracle/DB2/Snowflake/…) need a JRE + the catio-jdbc plugin jar
# that the desktop app wires up in its Tauri setup(). This image ships neither, so JDBC
# db_connect fails here. Native engines (Postgres/MySQL/SQLite/Mongo/Redis/ClickHouse/…) work.
# Adding the JRE + plugin is tracked for a later milestone.

# ── stage 1: frontend ────────────────────────────────────────────────────────
FROM node:20-bookworm AS web
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build        # tsc && vite build → /app/dist

# ── stage 2: rust server ─────────────────────────────────────────────────────
FROM rust:1-bookworm AS server
RUN apt-get update && apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
        librsvg2-dev libssl-dev libxdo-dev pkg-config \
        libudev-dev \
    && rm -rf /var/lib/apt/lists/*
# Build resilience on slow/flaky links: keep retrying, and never abort on cargo's default
# "too slow" check (<10 bytes/sec for 30s) which trips on a stalled crates.io fetch.
ENV CARGO_NET_RETRY=10 \
    CARGO_HTTP_LOW_SPEED_LIMIT=0 \
    CARGO_HTTP_TIMEOUT=300 \
    CARGO_HTTP_MULTIPLEXING=false
WORKDIR /app
COPY src-tauri ./src-tauri
WORKDIR /app/src-tauri
# Cache the downloaded registry across builds (BuildKit) so a code-only change doesn't re-fetch
# every dependency. Only the registry is cached — target/ stays in the layer for the COPY below.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --bin catio-server
RUN strip target/release/catio-server || true

# ── stage 3: runtime ─────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2 \
        libudev1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /app/src-tauri/target/release/catio-server /usr/local/bin/catio-server
COPY --from=web    /app/dist ./dist
ENV CATIO_PORT=8787 \
    CATIO_STATIC=/app/dist \
    CATIO_DATA=/app/data
VOLUME ["/app/data"]
EXPOSE 8787
# A LAN reverse proxy (nginx/caddy) terminates TLS in front of this (spec §6.3).
CMD ["catio-server"]
