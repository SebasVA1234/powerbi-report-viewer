# =============================================
# Dockerfile - Gateway de borde de Helper Ecualand
# =============================================
FROM node:18-alpine

WORKDIR /app

# Copiar package files primero (cache de Docker)
COPY package*.json ./

# Dependencias de producción (reproducible con el lockfile)
RUN npm ci --only=production

# Copiar el código del gateway
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Health del propio gateway (no depende del backend)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/__gateway/health || exit 1

CMD ["node", "server.js"]
