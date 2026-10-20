ARG ASTRBOT_IMAGE=soulter/astrbot:latest
FROM node:22-bookworm-slim AS node
FROM ${ASTRBOT_IMAGE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY requirements.txt /opt/owqs/requirements.txt
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/owqs/browsers
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk libstdc++6 \
    && python -m pip install --no-cache-dir -r /opt/owqs/requirements.txt \
    && python -m playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /AstrBot
