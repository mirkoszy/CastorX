# Builds the complete tenant image; nothing has to be built on the host first.
#   docker build -t castorx-backstage .

FROM node:24-trixie-slim AS base
# Compilers and Python build the native Node modules Backstage depends on.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY . .
RUN yarn install --immutable
RUN yarn tsc
RUN yarn build:backend

FROM base AS production-deps
ENV NODE_ENV=production
COPY .yarn ./.yarn
COPY .yarnrc.yml backstage.json yarn.lock package.json ./
COPY --from=build /app/packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz
RUN yarn workspaces focus --all --production && yarn cache clean --all

FROM node:24-trixie-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-deps --chown=node:node /app ./
COPY --from=build --chown=node:node /app/packages/backend/dist/bundle.tar.gz ./
COPY --chown=node:node app-config.yaml app-config.production.yaml ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz
USER node
EXPOSE 7007
CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
