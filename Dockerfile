# Build stage
FROM node:lts-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM node:lts-alpine
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY package.json package-lock.json ./
RUN npm ci --production --ignore-scripts

COPY --from=builder /app/dist ./dist
RUN chmod +x dist/index.cjs && chown -R nodejs:nodejs /app

ENV TRANSPORT=http
USER nodejs

EXPOSE 8080
ENTRYPOINT ["node", "dist/index.cjs"]
