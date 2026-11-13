# syntax=docker/dockerfile:1

# One image, two commands:
#   app:        node dist/main.js         (default)
#   migrations: node dist/db/migrate.js   (owner credentials, runs before each deploy)

FROM node:26.13.1-alpine3.24 AS base

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
