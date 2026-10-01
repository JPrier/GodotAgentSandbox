# syntax=docker/dockerfile:1
# Persistent home for the bridge server: run it on any VM/box and point your browser at it.
#   docker build -t godot-cloud-kit .
#   docker run -d -p 8790:8790 -v gck:/data -e GCK_TOKEN=change-me godot-cloud-kit
FROM node:22-bookworm-slim

ARG GODOT_VERSION=4.7.2
ARG WEB_EDITOR=0
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git python3 libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/root GCK_HOME=/data GODOT_BIN=/root/.local/bin/godot GCK_PORT=8790
WORKDIR /opt/gck
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN GODOT_VERSION=$GODOT_VERSION scripts/install-godot.sh $( [ "$WEB_EDITOR" = 1 ] && echo --web-editor ) \
    && ln -sf /opt/gck/cli/gck.js /usr/local/bin/gck \
    && git config --global --add safe.directory '*'

VOLUME /data
EXPOSE 8790
HEALTHCHECK CMD curl -fsS http://127.0.0.1:8790/api/health || exit 1
CMD ["node", "server/index.js"]
