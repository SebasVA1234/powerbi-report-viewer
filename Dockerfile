# =============================================
# Dockerfile - Power BI Report Viewer
# Optimizado para Railway
# =============================================

FROM node:18-alpine

# Instalar dependencias para compilar better-sqlite3
RUN apk add --no-cache python3 make g++ 

# Crear directorio de la aplicación
WORKDIR /app

# Crear directorio para la base de datos
RUN mkdir -p /app/database

# Copiar package files primero (para cache de Docker)
COPY package*.json ./

# Instalar dependencias
RUN npm ci --only=production

# Copiar el resto del código
COPY . .

# Exponer puerto
EXPOSE 3000

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/database/powerbi_reports.db

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Iniciar aplicación
CMD ["node", "server.js"]
