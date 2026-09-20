# ---- Python build stage ----
FROM ghcr.io/astral-sh/uv:python3.12-trixie-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

# Install dependencies first for a cache-friendly layer.
COPY pyproject.toml uv.lock .python-version ./

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# Copy the source and install the project itself.
COPY app ./app
COPY main.py ./main.py

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev


# ---- Runtime stage ----
FROM python:3.12-slim-trixie AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=58001 \
    TRIP_RECAP_DATA_DIR=/tmp/trip-recap \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# System dependencies required by the application at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        libimage-exiftool-perl \
    && rm -rf /var/lib/apt/lists/*

# Copy the application and the virtual environment built by uv.
COPY --from=builder /app /app

# Playwright installs its own Chromium build plus whatever OS libs it needs.
RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /tmp/trip-recap

EXPOSE 58001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '58001') + '/api/health', timeout=3).read()" || exit 1

CMD ["sh", "-c", "exec python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-58001} --proxy-headers --forwarded-allow-ips='*'"]
