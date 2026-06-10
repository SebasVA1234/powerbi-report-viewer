# =============================================
# Dockerfile - Helper Ecualand (Power BI Report Viewer)
# Multi-stage: el toolchain de compilación (python3/make/g++ para better-sqlite3)
# vive SÓLO en la etapa builder; la imagen final lleva nada más que node + los
# node_modules ya compilados + la app → ~100MB menos, deploys más rápidos.
# =============================================

# ---- Etapa builder: instala y compila dependencias nativas ----
FROM node:18-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Etapa runtime: imagen liviana, sin toolchain ----
FROM node:18-alpine
WORKDIR /app
RUN mkdir -p /app/database

# node_modules ya compilados desde el builder (mismo base alpine → el binario
# nativo de better-sqlite3 es compatible).
COPY --from=builder /app/node_modules ./node_modules
# El código de la app (node_modules está dockerignored → no pisa lo de arriba).
COPY . .

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/database/powerbi_reports.db

# Health check para Railway.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
