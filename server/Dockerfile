# No browser. Satori and resvg render in-process, so this image needs only
# ImageMagick (for the 16-level dither) and a font.
#
# That removes a good deal more than size: no shm_size workaround, no zombie
# Chromium processes to reap, no 150-300MB of RSS per render, and - the real
# win - no risk that a Chromium bump silently changes font hinting and alters
# every frame. Satori renders only from the fonts installed here.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      imagemagick \
      fonts-sil-charis \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Charis SIL is Bitstream Charter's OFL descendant. Charter was designed by
# Matthew Carter specifically for low-resolution output devices, which is
# precisely the e-ink problem, so it holds up well at 300ppi.
ENV FONT_REGULAR=/usr/share/fonts/truetype/charis/CharisSIL-Regular.ttf \
    FONT_BOLD=/usr/share/fonts/truetype/charis/CharisSIL-Bold.ttf

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app
ENV CONTENT_PATH=/app/data/content.md

USER node
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
