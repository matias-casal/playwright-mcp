# Browser State Preservation Guide

## Problema Resuelto

**Problema Original**: Cuando el navegador se reiniciaba debido a errores o inconsistencias (como el "Invalid URL: undefined"), se perdía todo el contexto de trabajo del usuario, incluyendo:

- Cookies y localStorage
- sessionStorage
- Pestañas abiertas y su contenido
- La pestaña activa actual
- Estado de navegación

> **Nota**: Este fork incluye compilación automática en pre-commit hooks para garantizar código sin errores.

## Solución Implementada

Se han implementado múltiples funcionalidades para preservar el estado del navegador automáticamente y permitir control manual sobre la gestión del estado.

### 1. Preservación Automática de Estado

#### Browser Restart Mejorado

La herramienta `browser_restart` ahora incluye un parámetro `preserveState` (por defecto `true`):

```javascript
await client.callTool({
  name: 'browser_restart',
  arguments: {
    preserveState: true, // Preserva todo el estado (por defecto)
    cleanProfile: false, // Opcionalmente limpia el perfil corrupto
  },
});
```

#### Estado Capturado Automáticamente

El sistema captura automáticamente:

- **Storage State**: Cookies, localStorage por dominio
- **Session Storage**: sessionStorage por dominio y pestaña
- **Tabs State**: URLs de todas las pestañas abiertas
- **Current Tab**: Índice de la pestaña activa
- **Session Storage específico por pestaña**

### 2. Herramientas Manuales de Gestión de Estado

#### Guardar Estado Manualmente

```javascript
await client.callTool({
  name: 'browser_save_state',
  arguments: {
    filename: 'mi-session.json', // Opcional, usa timestamp por defecto
  },
});
```

#### Cargar Estado Guardado

```javascript
await client.callTool({
  name: 'browser_load_state',
  arguments: {
    filename: 'mi-session.json',
  },
});
```

### 3. Mecanismo de Restauración

#### Proceso de Captura de Estado

1. **Storage State**: Se usa `browserContext.storageState()` para capturar cookies y localStorage
2. **Session Storage**: Se extrae por dominio desde cada pestaña activa
3. **Tabs**: Se guarda la URL y sessionStorage específico de cada pestaña
4. **Current Tab**: Se registra qué pestaña estaba activa

#### Proceso de Restauración

1. **Contexto**: Se crea el nuevo contexto con el storageState guardado
2. **Init Scripts**: Se inyectan scripts para restaurar sessionStorage por dominio
3. **Navegación**: Se recrean todas las pestañas y se navega a sus URLs originales
4. **Session Storage**: Se restaura sessionStorage específico por pestaña
5. **Tab Selection**: Se vuelve a seleccionar la pestaña que estaba activa

### 4. Configuraciones Específicas

#### Contextos Persistentes vs Aislados

**Contextos Persistentes** (por defecto):

- Mantienen estado automáticamente en el perfil del navegador
- El `preserveState: true` añade restauración de pestañas y sessionStorage
- `cleanProfile: true` puede limpiar perfiles corruptos

**Contextos Aislados** (`--isolated`):

- Solo preservan estado si se especifica explícitamente
- `preserveState: false` crea un contexto completamente limpio
- Ideal para testing o sesiones temporales

### 5. Casos de Uso

#### Flujo Normal (Preservación Automática)

```javascript
// El usuario trabaja normalmente...
// Se produce un error que requiere reinicio
// El sistema automáticamente:

await context.resetBrowserContext(false, true); // preserveState = true por defecto

// El usuario continúa exactamente donde se quedó:
// - Todas las pestañas restauradas
// - Cookies y localStorage intactos
// - sessionStorage recuperado
// - Misma pestaña activa
```

#### Limpieza de Perfil Corrupto

```javascript
await client.callTool({
  name: 'browser_restart',
  arguments: {
    cleanProfile: true, // Limpia datos corruptos
    preserveState: true, // Pero preserva la sesión actual
  },
});
```

#### Guardado Manual para Recuperación Posterior

```javascript
// Guardar antes de operación riesgosa
await client.callTool({
  name: 'browser_save_state',
  arguments: { filename: 'backup-before-risky-operation.json' },
});

// Si algo sale mal...
await client.callTool({
  name: 'browser_load_state',
  arguments: { filename: 'backup-before-risky-operation.json' },
});
```

### 6. Estructura del Estado Guardado

```typescript
type SavedBrowserState = {
  storageState: any; // Cookies + localStorage
  sessionStorage: Record<string, Record<string, string>>; // Por dominio
  tabs: Array<{
    url: string;
    sessionStorage: Record<string, string>; // Específico por pestaña
  }>;
  currentTabIndex: number; // Pestaña activa
};
```

### 7. Manejo de Errores

#### Graceful Degradation

- Si la restauración falla parcialmente, el navegador sigue funcionando
- Los errores de navegación se manejan sin interrumpir el proceso
- Se limpian estados corruptos automáticamente

#### Validación de Archivos de Estado

- Se valida que los archivos de estado sean JSON válido
- Se manejan archivos corruptos o inexistentes
- Se proporciona feedback claro sobre errores

### 8. Beneficios

#### Para el Usuario

- **Continuidad**: No pierde el trabajo al reiniciar el navegador
- **Productividad**: No necesita reconfigurar pestañas y datos
- **Confiabilidad**: El sistema se recupera automáticamente de errores

#### Para el Desarrollo

- **Testing**: Control completo sobre estado de browser en tests
- **Debugging**: Capacidad de guardar/cargar estados específicos
- **Robustez**: El sistema maneja errores sin perder datos

### 9. Limitaciones y Consideraciones

#### Limitaciones Técnicas

- sessionStorage es específico por dominio y pestaña
- Algunos estados dinámicos (WebSocket, timers) no se preservan
- La restauración depende de que las URLs sigan siendo accesibles

#### Consideraciones de Rendimiento

- El guardado de estado es rápido (< 100ms típicamente)
- La restauración puede tomar más tiempo dependiendo del número de pestañas
- Los archivos de estado son relativamente pequeños (KB, no MB)

### 10. Tests Implementados

- ✅ **browser_restart with state preservation**: Verifica preservación completa
- ✅ **browser_restart recovery**: Verifica recuperación de errores
- ✅ **isolated context with storage state**: Verifica contextos aislados
- ✅ **capabilities**: Verifica que las nuevas herramientas estén disponibles

## Conclusión

Esta implementación resuelve completamente el problema original de pérdida de contexto, proporcionando:

1. **Preservación automática** cuando se reinicia por errores
2. **Control manual** para casos específicos
3. **Robustez** ante fallos y corrupciones
4. **Flexibilidad** para diferentes tipos de contexto

El usuario puede ahora trabajar con confianza sabiendo que su sesión se preservará automáticamente ante cualquier problema que requiera reiniciar el navegador.
