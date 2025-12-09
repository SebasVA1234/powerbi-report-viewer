# 📊 Sistema de Gestión de Reportes Power BI (Cualand)

[![Version](https://img.shields.io/badge/version-1.0.0-blueviolet.svg?style=flat-square)](https://github.com/SebasVA1234/powerbi-report-viewer)
[![Node.js](https://img.shields.io/badge/Node.js-RunTime-green.svg?style=flat-square)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-Database-003B57.svg?style=flat-square)](https://www.sqlite.org/)

> **Una plataforma centralizada, segura y optimizada para la visualización de dashboards corporativos.**

---

## 🖼️ Vista Previa del Sistema

<div align="center">
  <img src="assets/dashboard.png" alt="Panel Principal Cualand" width="850" style="border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">
  <p>
    <em>Panel de bienvenida al administrador mostrando los reportes disponibles.</em>
  </p>
</div>

---

## 🚀 Acerca del Proyecto

Este sistema resuelve la necesidad de compartir reportes de Power BI de manera segura y profesional, eliminando la dependencia de enlaces dispersos.

Actúa como un contenedor inteligente que autentica a los usuarios y optimiza la visualización. Además, incorpora una lógica de organización dinámica en el panel principal: las tarjetas se agrupan automáticamente por categorías, lo cual facilita al Administrador la auditoría visual y el control granular sobre qué reportes son accesibles para el personal.

### ✨ Características Clave

#### 1. Autenticación Segura y Personalizada
Olvídate de los logins genéricos. El sistema cuenta con su propia puerta de entrada segura con la identidad de marca.

<div align="center">
  <img src="assets/login.png" alt="Pantalla de Login" width="400" style="border-radius: 8px;">
</div>

#### 2. Visualización Optimizada (Mejora de Ventanas)
Hemos implementado un gestor de ventanas que maximiza el área de visualización del reporte. El contenedor se ajusta dinámicamente, eliminando barras de desplazamiento innecesarias y centrando la atención en los datos de Power BI.

<div align="center">
  <img src="assets/frame.png" alt="Marco de Power BI" width="700" style="border-radius: 8px; border: 1px solid #ddd;">
  <p><em>El marco de aplicación (barra superior morada) integra la carga del reporte de PBI de forma fluida.</em></p>
</div>

#### 3. Gestión de Roles
* **Administradores:** Acceso total a todos los reportes y configuraciones.
* **Usuarios:** Acceso limitado a los reportes asignados a su perfil.

---

## 🛠️ Stack Tecnológico

* **Backend:** Node.js + Express (Rápido y ligero)
* **Base de Datos:** SQLite (Autocontenida, sin configuración de servidor)
* **Frontend Integration:** Power BI Embedded API
* **UI/UX:** HTML5, CSS3 Moderno

---

## 🏁 Despliegue Rápido (Local)

Clona y ejecuta el proyecto en minutos. La base de datos se inicializa sola.

1.  **Instalar dependencias:**
    \`npm install\`

2.  **Iniciar el servidor:**
    \`npm start\`
    *Visita http://localhost:3000*

### �� Credenciales de Prueba (Desarrollo)

El sistema genera estos usuarios automáticamente al iniciar por primera vez:

| Rol | Usuario | Contraseña |
| :--- | :--- | :--- |
| 👑 **Admin** | \`admin\` | \`admin123\` |
| 👤 **Usuario** | \`usuario1\` | \`user123\` |

---

<div align="center">
  <sub>Desarrollado para <strong>Cualand Flowers & Logistics</strong></sub>
  <br>
  <sub>Con ❤️ por <a href="https://github.com/SebasVA1234">SebasVA1234</a></sub>
</div>
