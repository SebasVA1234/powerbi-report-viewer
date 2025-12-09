# Power BI Report Viewer

Sistema de gestión de reportes Power BI con control de acceso y sistema de ventanas múltiples.

## ✨ Características

- **Sistema de ventanas múltiples**: Abre hasta 5 reportes simultáneamente (configurable por admin)
- **Ventanas arrastrables y redimensionables**: Estilo Windows
- **Minimizar/Maximizar/Cerrar**: Controles completos por ventana
- **Barra de tareas**: Acceso rápido a reportes minimizados
- **Control de acceso granular**: Permisos por usuario/reporte
- **Panel de administración**: Gestión de usuarios, reportes y configuración

## 🚀 Instalación Local

```bash
# Instalar dependencias
npm install

# Copiar configuración
cp .env.example .env

# Editar .env con tus valores

# Iniciar servidor
npm start
```

## 🔐 Credenciales por defecto

- **Usuario:** `admin`
- **Contraseña:** `admin123`

⚠️ **Cambiar inmediatamente después del primer login**

## ⚙️ Configuración de Ventanas

El administrador puede configurar el máximo de ventanas:

1. Ir a **Administración** → **Configuración**
2. Cambiar "Máximo de ventanas abiertas" (1-10)
3. Guardar
