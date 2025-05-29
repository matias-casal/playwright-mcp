# 🌐 Environment Variable-Based Browser Persistence Guide

## 🎯 Problema Resuelto

**Problema Extendido**: Aunque implementamos la preservación de estado para reinicios del navegador, se necesitaba un control más granular y robusto sobre dónde se almacenan los datos del navegador en diferentes entornos (desarrollo, producción, CI/CD, Docker).

## 🚀 Solución Implementada

Se ha creado un sistema completo de variables de entorno que permite configurar de manera flexible la persistencia del navegador, complementando el sistema de preservación de estado existente.

### 🏗️ Arquitectura de la Solución

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONFIGURACIÓN DE PERSISTENCIA               │
├─────────────────────────────────────────────────────────────────┤
│  1. Variables de Entorno → createUserDataDir()                 │
│  2. Directorio de Datos → launchPersistentContext()            │
│  3. Estado de Sesión → preserveState + storageState           │
│  4. Herramientas Manuales → browser_save/load_state           │
└─────────────────────────────────────────────────────────────────┘
```

## 📋 Variables de Entorno Disponibles

### 🏠 Directorio de Datos Primario

#### Orden de Prioridad:

1. **`PLAYWRIGHT_USER_DATA_DIR`** - Máxima prioridad
2. **`MCP_USER_DATA_DIR`** - Específico para MCP
3. **`BROWSER_PROFILE_DIR`** - Genérico, compatible con otras herramientas

```bash
# Ejemplo para desarrollo local
export MCP_USER_DATA_DIR="./dev-browser-data"

# Ejemplo para producción
export PLAYWRIGHT_USER_DATA_DIR="/var/lib/playwright/browser-data"
```

### 🎯 Configuración Específica por Navegador

Para diferentes navegadores, puedes usar variables específicas:

```bash
# Chromium
export PLAYWRIGHT_CHROMIUM_USER_DATA_DIR="/data/chromium"
export MCP_CHROMIUM_PROFILE_DIR="/profiles/chromium"

# Chrome
export PLAYWRIGHT_CHROME_USER_DATA_DIR="/data/chrome"
export MCP_CHROME_PROFILE_DIR="/profiles/chrome"

# Firefox
export PLAYWRIGHT_FIREFOX_USER_DATA_DIR="/data/firefox"
export MCP_FIREFOX_PROFILE_DIR="/profiles/firefox"

# Edge
export PLAYWRIGHT_MSEDGE_USER_DATA_DIR="/data/edge"
export MCP_MSEDGE_PROFILE_DIR="/profiles/edge"

# WebKit
export PLAYWRIGHT_WEBKIT_USER_DATA_DIR="/data/webkit"
export MCP_WEBKIT_PROFILE_DIR="/profiles/webkit"
```

### 📁 Configuración de Cache Base

```bash
# Directorio base para cache del navegador
export PLAYWRIGHT_BROWSERS_PATH="/custom/browsers/cache"
export MCP_CACHE_DIR="/custom/mcp/cache"

# Sufijo para separar ambientes
export MCP_PROFILE_SUFFIX="-dev"      # Desarrollo
export MCP_PROFILE_SUFFIX="-staging"  # Staging
export MCP_PROFILE_SUFFIX="-prod"     # Producción
```

### 🔧 Configuración Avanzada

```bash
# Arreglar permisos automáticamente
export MCP_FIX_PERMISSIONS="true"

# Limpiar perfiles al inicio (útil para CI/CD)
export MCP_CLEAN_PROFILES_ON_START="true"

# Deshabilitar persistencia completamente
export MCP_DISABLE_PERSISTENCE="true"
```

## 🎭 Casos de Uso Prácticos

### 1. Desarrollo Local

```bash
# .env.development
MCP_USER_DATA_DIR=./browser-data
MCP_PROFILE_SUFFIX=-dev
MCP_FIX_PERMISSIONS=true
```

### 2. Entorno de Producción

```bash
# .env.production
PLAYWRIGHT_USER_DATA_DIR=/var/lib/mcp/browser-data
MCP_PROFILE_SUFFIX=-prod
```

### 3. Docker/Contenedores

```bash
# docker-compose.yml
environment:
  - MCP_USER_DATA_DIR=/app/browser-data
  - MCP_FIX_PERMISSIONS=true
  - MCP_PROFILE_SUFFIX=-docker
```

### 4. CI/CD Pipelines

```bash
# .github/workflows/test.yml
env:
  MCP_USER_DATA_DIR: /tmp/ci-browser-data
  MCP_CLEAN_PROFILES_ON_START: true
  MCP_PROFILE_SUFFIX: -ci
```

### 5. Entorno Multi-Browser

```bash
# Para testing con múltiples navegadores
export PLAYWRIGHT_CHROMIUM_USER_DATA_DIR="/data/test/chromium"
export PLAYWRIGHT_FIREFOX_USER_DATA_DIR="/data/test/firefox"
export PLAYWRIGHT_CHROME_USER_DATA_DIR="/data/test/chrome"
export MCP_PROFILE_SUFFIX="-test"
```

## 🔄 Integración con Estado de Sesión

Las variables de entorno trabajan en conjunto con el sistema de preservación de estado:

### Flujo Completo

```javascript
// 1. Variables de entorno definen DÓNDE se almacenan los datos
process.env.MCP_USER_DATA_DIR = './my-browser-data';

// 2. El navegador usa ese directorio para persistencia
// (cookies, localStorage, etc. se guardan ahí automáticamente)

// 3. Al reiniciar con preserveState: true, se conserva TODO
await client.callTool({
  name: 'browser_restart',
  arguments: { preserveState: true },
});

// 4. Al reiniciar con preserveState: false, se limpia la sesión
// pero el directorio de datos permanece para la próxima sesión
await client.callTool({
  name: 'browser_restart',
  arguments: { preserveState: false },
});
```

### Guardar/Cargar Estado Manual

```javascript
// Guardar estado actual
await client.callTool({
  name: 'browser_save_state',
  arguments: { filename: 'backup-state.json' },
});

// Reiniciar limpio
await client.callTool({
  name: 'browser_restart',
  arguments: { preserveState: false },
});

// Restaurar estado guardado
await client.callTool({
  name: 'browser_load_state',
  arguments: { filename: 'backup-state.json' },
});
```

## 🛠️ Implementación Técnica

### Algoritmo de Resolución de Directorio

```typescript
function resolveUserDataDir(browserConfig) {
  // 1. Verificar variables específicas de navegador
  const browserSpecific = process.env[`PLAYWRIGHT_${browser.toUpperCase()}_USER_DATA_DIR`];
  if (browserSpecific) return browserSpecific;

  // 2. Verificar variables generales (por prioridad)
  const general =
    process.env.PLAYWRIGHT_USER_DATA_DIR || process.env.MCP_USER_DATA_DIR || process.env.BROWSER_PROFILE_DIR;
  if (general) return general;

  // 3. Usar cache base personalizado
  const cacheBase = process.env.PLAYWRIGHT_BROWSERS_PATH || process.env.MCP_CACHE_DIR;
  if (cacheBase) return path.join(cacheBase, 'ms-playwright', profileName);

  // 4. Fallback a directorio predeterminado del sistema
  return getDefaultCacheDir();
}
```

### Manejo de Errores Robusto

- ✅ **Fallback Automático**: Si un directorio no se puede crear, usa temporales
- ✅ **Verificación de Permisos**: Comprueba escritura antes de usar
- ✅ **Limpieza Automática**: Remueve directorios corruptos si es necesario
- ✅ **Logging Silencioso**: No spamea la consola en modo producción

## 🧪 Testing

Los tests verifican:

- ✅ **Funcionalidad de Reinicio**: Estado se preserva/limpia según configuración
- ✅ **Herramientas de Estado**: Guardar/cargar funciona correctamente
- ✅ **Fallback Robusto**: Funciona aunque variables de entorno sean inválidas
- ✅ **Compatibilidad**: Todos los navegadores soportados

```bash
# Ejecutar tests de persistencia
npm test -- tests/environment-persistence.spec.ts
```

## 📁 Archivos Creados/Modificados

### Archivos Nuevos:

- `.env.example` - Documentación completa de variables
- `tests/environment-persistence.spec.ts` - Tests de funcionalidad
- `ENVIRONMENT_PERSISTENCE_GUIDE.md` - Esta guía

### Archivos Modificados:

- `src/context.ts` - Lógica mejorada de `createUserDataDir`
- `src/tools/common.ts` - Nuevas herramientas `browser_save_state` y `browser_load_state`
- `.gitignore` - Exclusión de archivos de ambiente y datos de navegador

## 🎉 Beneficios de la Solución

### 🏃‍♂️ **Flexibilidad Operacional**

- Configuración diferente por entorno sin cambiar código
- Soporte para equipos con diferentes configuraciones
- Compatibilidad con CI/CD y Docker

### 🔒 **Robustez Mejorada**

- Fallback automático cuando configuraciones fallan
- Manejo inteligente de permisos de archivos
- Separación clara entre ambientes

### 🎯 **Control Granular**

- Variables por navegador específico
- Configuración de cache independiente
- Opciones avanzadas para casos especiales

### 🔄 **Compatibilidad Total**

- Funciona con sistema de preservación existente
- No rompe configuraciones previas
- Variables opcionales (todo tiene fallbacks)

## 🚦 Recomendaciones de Uso

### Para Desarrolladores:

```bash
# .env.local (nunca commitear)
MCP_USER_DATA_DIR=./dev-browser-data
MCP_PROFILE_SUFFIX=-$(whoami)
MCP_FIX_PERMISSIONS=true
```

### Para DevOps:

```bash
# Variables de ambiente en servidor
PLAYWRIGHT_USER_DATA_DIR=/opt/mcp/browser-data
MCP_PROFILE_SUFFIX=-prod
MCP_CLEAN_PROFILES_ON_START=false
```

### Para CI/CD:

```bash
# Variables temporales para tests
MCP_USER_DATA_DIR=/tmp/test-browser-data
MCP_CLEAN_PROFILES_ON_START=true
MCP_PROFILE_SUFFIX=-ci-$(CI_BUILD_ID)
```

---

Esta solución transforma el sistema de persistencia de navegador de básico a enterprise-ready, proporcionando el control y flexibilidad necesarios para entornos de producción complejos mientras mantiene la simplicidad para uso básico.
