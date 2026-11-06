FROM node:22-alpine
ARG APP_VERSION=0.1.0
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package*.json ./
# Uses the lockfile when present (commit package-lock.json after the first `npm install`).
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
