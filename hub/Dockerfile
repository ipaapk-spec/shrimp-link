FROM node:22-alpine

WORKDIR /app

COPY hub/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY hub/src ./src
COPY hub/public ./public
COPY ONBOARDING.md /app/ONBOARDING.md

ENV DB_PATH=/data/shrimp-link.db
ENV FILES_DIR=/data/files
ENV PORT=3250
ENV ONBOARDING_PATH=/app/ONBOARDING.md

VOLUME ["/data"]
EXPOSE 3250

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3250/v1/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
