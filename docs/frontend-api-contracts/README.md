# Contratos API para el frontend (Angular 22)

Documentación técnica de los contratos **reales** entre el backend NestJS de Servicios Hogar y el frontend Angular. Se obtuvo leyendo el código: controllers, services, DTOs, guards, filtros, configuración global y esquema Prisma. Cada respuesta se comprobó siguiendo el flujo controller → service → objeto devuelto, no a partir del esquema Prisma.

> **Fuente de verdad:** el código del backend. Si esta documentación y el código difieren, manda el código y hay que actualizar este documento.
>
> **Versión inspeccionada:** commit `207f2cb` (rama `main`). Ese commit, que incluye OrdersModule, las solicitudes de cambio de zona, la cola de borrado de archivos y las migraciones `20261114000000` y `20261115000000`, **todavía no está en `origin/main`**: quien clone el repositorio remoto antes del push no tendrá los endpoints de pedidos.

## Índice

| Archivo | Contenido |
|---|---|
| [01-endpoints-inventory.md](01-endpoints-inventory.md) | Inventario completo de los 54 endpoints existentes |
| [02-request-dtos.md](02-request-dtos.md) | DTOs de entrada, validaciones y ejemplos |
| [03-response-models.md](03-response-models.md) | Modelos de respuesta reales y ejemplos JSON |
| [04-enums-and-states.md](04-enums-and-states.md) | Enumeraciones, estados y transiciones comprobadas |
| [05-auth-and-permissions.md](05-auth-and-permissions.md) | Autenticación, autorización y visibilidad de datos |
| [06-file-contracts.md](06-file-contracts.md) | Subida, descarga y procesamiento de archivos |
| [07-angular-types.md](07-angular-types.md) | Interfaces TypeScript propuestas para Angular |
| [08-feature-mapping.md](08-feature-mapping.md) | Correspondencia con los 12 módulos funcionales (RF-01 a RF-56) |
| [09-gaps-and-pending-contracts.md](09-gaps-and-pending-contracts.md) | Faltantes, inconsistencias y contratos pendientes |

## Cómo usar esta documentación

1. Busque el endpoint en **01** para saber ruta, permisos, entrada, respuesta y códigos HTTP.
2. Construya el formulario o la petición con **02**: validaciones exactas, qué se puede omitir y qué admite `null`.
3. Tipifique la respuesta con **03** y **07**. Los tipos de 07 son una *propuesta* que reproduce exactamente los contratos de 03.
4. Antes de mostrar una acción o un dato, revise **05**: quién puede verlo o ejecutarlo y en qué estado.
5. Para todo lo que no aparezca en el inventario, revise **08** y **09**: si no existe, **no tiene contrato** y no debe inventarse.

## Leyenda de estado

| Estado | Significado |
|---|---|
| ✅ Implementado y disponible | Existe el endpoint, funciona de punta a punta y está cubierto por pruebas e2e |
| 🟡 Implementado parcialmente | Existe código o endpoint, pero falta una parte necesaria del flujo |
| 📐 Diseñado, no implementado | Hay diseño o puntos de integración internos, pero ningún endpoint HTTP |
| ⛔ No implementado | No existe nada en el backend |
| ❓ Pendiente de decisión | Depende de una decisión del docente o del equipo |

## Convenciones generales del backend

| Tema | Convención real |
|---|---|
| URL base (desarrollo) | `http://localhost:3000/api`: puerto `PORT` (por defecto 3000) y prefijo global `api` |
| CORS | Origen permitido: `CORS_ORIGIN` (por defecto `http://localhost:4200`). Métodos: GET, POST, PUT, PATCH, DELETE. Headers: `Content-Type`, `Authorization`. Sin credenciales (cookies) y sin headers expuestos. |
| Autenticación | `Authorization: Bearer <accessToken>`; no se usan cookies (ver 05) |
| Formato | JSON en cuerpo y respuesta, salvo las subidas (`multipart/form-data`) y las descargas (binario) |
| Fechas | Strings ISO 8601 en UTC con milisegundos, por ejemplo `"2026-11-15T14:30:00.000Z"`. El backend serializa objetos `Date` con `JSON.stringify`. |
| Montos | `budgetAmount` se **envía** como string (también acepta un número JSON) y se **recibe** como string con 2 decimales, por ejemplo `"150.50"` |
| Identificadores | UUID. Los parámetros de ruta pasan por `ParseUUIDPipe`: un id que no es UUID responde 400 |
| Horas | `"HH:mm"` en 24 horas (los horarios de atención admiten `"24:00"` como fin) |
| Paginación | `{ data: T[], meta: { page, limit, total, totalPages } }`. Solo en usuarios, bitácora, pedidos y solicitudes de cambio de zona del administrador; los demás listados devuelven un arreglo simple |
| Propiedades extra | El `ValidationPipe` global usa `whitelist`, `forbidNonWhitelisted` y `transform`. **Cualquier propiedad no declarada en el DTO responde 400**: no reenvíe objetos de respuesta completos en un PATCH |
| Strings de entrada | La mayoría de los textos pasan por `@Trim()`: se recortan los espacios antes de validar |
| Errores | `{ statusCode: number, message: string \| string[], error?: string }`. `message` es un **arreglo** en los errores de validación y en algunos errores de negocio (ver 03 y 09) |
| Idioma | Los mensajes de error y de negocio están en español y se pueden mostrar al usuario; los de validación automática de class-validator mezclan el nombre del campo en inglés |
| Serialización | No hay interceptores globales ni `ClassSerializerInterceptor`: lo que construye el service es exactamente lo que llega |
| OpenAPI / Swagger | **No existe**. Esta documentación es el contrato |

## Semántica de "opcional" y `null` (importante)

| Decorador en el DTO | Omitir la propiedad | Enviar `null` | Ejemplo |
|---|---|---|---|
| Sin `@IsOptional` ni `@ValidateIf` | ❌ 400 | ❌ 400 | `RegisterDto.email` |
| `@IsOptional()` | ✅ | ✅ (null se acepta y el service lo trata como "sin valor" o "borrar") | `UpdateUserDto.phone` |
| `@ValidateIf(value !== undefined)` | ✅ | ❌ 400 (null se valida y falla) | `UpdateUserDto.firstName` |

En 02 se indica para cada propiedad cuál de los tres casos aplica.
