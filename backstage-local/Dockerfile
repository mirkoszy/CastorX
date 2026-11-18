FROM node:24-trixie-slim

# Compilers and Python build the native Node modules Backstage depends on.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 libsqlite3-dev git \
    && rm -rf /var/lib/apt/lists/*

# Create these before the volumes mount so the volumes belong to the node user.
RUN mkdir -p /workspace /home/node/.yarn && chown -R node:node /workspace /home/node/.yarn

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
