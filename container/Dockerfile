# syntax=docker/dockerfile:1.7
# Luna Agent Container
# Runs OpenAI-compatible agent loop in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (agent-browser, vercel): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG AGENT_BROWSER_VERSION=0.38.0
ARG VERCEL_VERSION=52.2.1
ARG TAVILY_MCP_VERSION=0.2.20
ARG BUN_VERSION=1.3.12

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so in-flight Session API writes finish on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
        poppler-utils \
        pandoc \
        tesseract-ocr \
        tesseract-ocr-eng \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips agent-browser's bin chmod. Keep this in lockstep with
# package.json's `packageManager`.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "tavily-mcp@${TAVILY_MCP_VERSION}"

# ---- Agent toolbelt ----------------------------------------------------------
# CLI tools the agent reaches for constantly. Kept in its own late layer on
# purpose: editing this list must not invalidate `bun install` or the three
# `pnpm install -g` layers above it.
#
# Deliberately absent, so the agent stops guessing (see fragments/tools.md):
#   libreoffice     — 400MB+; tell the user to re-save as .docx/.pdf instead
#   python3         — not in node:22-slim, and then every pip install is a
#                     fresh install problem; Bun/Node is the scripting runtime
#   build-essential — 200MB+, and its purpose is compiling arbitrary downloaded
#                     C as a side effect of `pnpm install`
#   ghostscript     — the delegate behind the ImageMagick RCE class that
#                     imagemagick-policy.xml exists to block; pdftoppm already
#                     rasterizes PDFs natively
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        imagemagick \
        fonts-urw-base35 \
        ffmpeg \
        jq \
        sqlite3 \
        ripgrep \
        zip \
    && rm -rf /var/lib/apt/lists/*

# fonts-urw-base35 above is not optional and not cosmetic. ImageMagick's stock
# /etc/ImageMagick-6/type.xml does `<include file="type-urw-base35.xml"/>`, and
# with those fonts absent any default-font text operation — `-draw text`,
# `-annotate`, `label:` — dies on SIGABRT with **no message at all** (exit 134,
# empty stderr). Passing an explicit `-font` sidesteps it, but a silent crash is
# the worst failure mode to hand an agent, so install the fonts type.xml expects.
# ~10MB, fonts only; it does not pull the ghostscript binary.

# Overwrite the distro ImageMagick policy with ours (denies the shell-out and
# remote-fetch coders, caps resources). Both paths are covered because the
# base image's ImageMagick major version is not pinned by us.
COPY imagemagick-policy.xml /tmp/imagemagick-policy.xml
RUN for d in /etc/ImageMagick-6 /etc/ImageMagick-7; do \
        [ -d "$d" ] && cp /tmp/imagemagick-policy.xml "$d/policy.xml"; \
    done; \
    rm /tmp/imagemagick-policy.xml

# ImageMagick 6 (Debian bookworm) has no `magick` binary, but models reach for
# it reflexively — without this, every image task burns a turn on
# "magick: command not found". Self-disabling if the base image ever ships IM7.
RUN if ! command -v magick >/dev/null 2>&1 && command -v convert >/dev/null 2>&1; then \
      printf '#!/bin/sh\n# ImageMagick 6 compat shim: `magick <tool> ...` and `magick <args>` both work.\ncase "$1" in\n  convert|identify|mogrify|montage|composite|compare|stream|conjure) exec "$@" ;;\n  *) exec convert "$@" ;;\nesac\n' > /usr/local/bin/magick \
      && chmod 0755 /usr/local/bin/magick; \
    fi

# ---- luna CLI wrapper ---------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/luna.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/luna.ts "$@"\n' > /usr/local/bin/luna && \
    chmod +x /usr/local/bin/luna

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/agent /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

USER node
WORKDIR /workspace/agent

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
