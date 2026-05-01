FROM node:24-bookworm

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV SHELL=/bin/bash
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    git \
    openssh-server \
    curl \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh docker.io \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && pnpm setup \
    && npm install -g @anthropic-ai/claude-code \
    && pnpm approve-builds --all -g

# Install devcontainer CLI
RUN curl -fsSL https://raw.githubusercontent.com/devcontainers/cli/main/scripts/install.sh | sh \
    && ln -s /root/.devcontainers/bin/devcontainer /usr/local/bin/devcontainer

RUN mkdir -p /var/run/sshd \
    && echo "PermitRootLogin yes" >> /etc/ssh/sshd_config \
    && echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config \
    && echo "KbdInteractiveAuthentication yes" >> /etc/ssh/sshd_config

WORKDIR /build

# Copy workspace files needed for building
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json tsconfig.lib.json ./
COPY vite.config.ts ./
COPY src/ src/

# Install dependencies and build, then prepare runtime image
RUN pnpm install --frozen-lockfile \
    && npx vite build \
    && mkdir -p /opt/auto-dev \
    && cp -r /build/dist /opt/auto-dev/dist \
    && node --input-type=commonjs -e "var fs=require('node:fs');var pkg=JSON.parse(fs.readFileSync('/build/package.json','utf8'));var prodPkg={type:'module',dependencies:pkg.dependencies};fs.writeFileSync('/opt/auto-dev/package.json',JSON.stringify(prodPkg));" \
    && cd /opt/auto-dev \
    && npm install --no-package-lock

WORKDIR /workspace

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && printf '#!/bin/bash\nexec node /opt/auto-dev/dist/cli.js "$@"\n' > /usr/local/bin/auto-dev \
    && chmod +x /usr/local/bin/auto-dev

EXPOSE 22
ENTRYPOINT ["docker-entrypoint.sh"]
