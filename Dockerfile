FROM node:18-alpine3.19

WORKDIR /app

# Install dependencies and set timezone
RUN corepack enable && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    apk add --no-cache git tzdata

# Copy dependency manifests
COPY package.json yarn.lock tsconfig.json ./

# Install dependencies
RUN yarn --frozen-lockfile --ignore-optional --network-timeout 120000 && \
    yarn add mysql2 node-cron@3.0.3 --network-timeout 120000

# Copy source code
COPY src ./src
COPY scheduler.ts ./
COPY assets ./assets

# Volume for sync data
VOLUME /app/db

EXPOSE 9610

CMD ["yarn", "ts-node", "--skip-project", "-T", "scheduler.ts"]
