# ---- Frontend build stage ----
FROM node:22-bookworm-slim AS web-builder

WORKDIR /web

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY next.config.ts tsconfig.json next-env.d.ts ./
COPY src ./src
COPY app/layout.tsx app/page.tsx ./app/
COPY app/icon.svg ./app/icon.svg
COPY app/recap ./app/recap

RUN npm run build


# ---- Frontend runtime stage ----
FROM nginx:1.27-alpine AS frontend

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-builder /web/out /usr/share/nginx/html


# ---- Python build stage ----
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

# Install dependencies first for a cache-friendly layer.
COPY pyproject.toml .python-version ./

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-install-project --no-dev

# Copy the source and install the project itself.
COPY . .
COPY --from=web-builder /web/out ./out

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-dev


# ---- Runtime stage ----
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    PORT=8000 \
    TRIP_RECAP_DATA_DIR=/tmp/trip-recap \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# System dependencies required by the application at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        ffmpeg \
        fonts-liberation \
        fonts-noto-color-emoji \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libimage-exiftool-perl \
        libnss3 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy the application and the virtual environment built by uv.
COPY --from=builder /app /app

RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /tmp/trip-recap \
    && chown -R appuser:appuser /app /tmp/trip-recap

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/api/health', timeout=3).read()" || exit 1

CMD ["sh", "-c", "exec python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
