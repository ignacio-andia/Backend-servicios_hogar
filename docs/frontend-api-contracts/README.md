<!--
//=========================================================
// MODIFICADO: README.md
// Fase B4 (cancelacion): el indice cuenta tambien la consulta #116.
//=========================================================
-->

# Contratos API para el frontend (Angular 22)

Documentación técnica de los contratos **reales** entre el backend NestJS de Servicios Hogar y el frontend Angular. Se obtuvo leyendo el código: controllers, services, DTOs, guards, filtros, configuración global y esquema Prisma. Cada respuesta se comprobó siguiendo el flujo controller → service → objeto devuelto, no a partir del esquema Prisma.

> **Fuente de verdad:** el código del backend. Si esta documentación y el código difieren, manda el código y hay que actualizar este documento.
>
> **Versión inspeccionada:** rama `integration/sprint-1` con sus cambios locales de integración (ver [09](09-gaps-and-pending-contracts.md), A2). Los #1–#81 se documentaron con las correcciones de cierre de T4; los #82–#115 (Sprint 1) se añadieron en [10](10-sprint1-endpoints.md).

## Índice

| Archivo                                                              | Contenido                                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [01-endpoints-inventory.md](01-endpoints-inventory.md)               | Inventario completo de los 116 endpoints existentes                                      |
| [02-request-dtos.md](02-request-dtos.md)                             | DTOs de entrada, validaciones y ejemplos                                                 |
| [03-response-models.md](03-response-models.md)                       | Modelos de respuesta reales y ejemplos JSON                                              |
| [04-enums-and-states.md](04-enums-and-states.md)                     | Enumeraciones, estados y transiciones comprobadas                                        |
| [05-auth-and-permissions.md](05-auth-and-permissions.md)             | Autenticación, autorización y visibilidad de datos                                       |
| [06-file-contracts.md](06-file-contracts.md)                         | Subida, descarga y procesamiento de archivos                                             |
| [07-angular-types.md](07-angular-types.md)                           | Interfaces TypeScript propuestas para #1–#81 y enumeraciones compartidas; #82–#116 en 10 |
| [08-feature-mapping.md](08-feature-mapping.md)                       | Correspondencia con los 12 módulos funcionales (RF-01 a RF-56)                           |
| [09-gaps-and-pending-contracts.md](09-gaps-and-pending-contracts.md) | Faltantes, inconsistencias y contratos pendientes                                        |
| [10-sprint1-endpoints.md](10-sprint1-endpoints.md)                   | Flujo del trabajo, reclamos, pagos, calificaciones, agenda y seguimiento (#82–#116)      |

## Cómo usar esta documentación

1. Busque el endpoint en **01** para saber ruta, permisos, entrada, respuesta y códigos HTTP.
2. Construya el formulario o la petición con **02**: validaciones exactas, qué se puede omitir y qué admite `null`.
3. Tipifique la respuesta con **03** y **07**. Los tipos de 07 son una _propuesta_ que reproduce exactamente los contratos de 03.
4. Antes de mostrar una acción o un dato, revise **05**: quién puede verlo o ejecutarlo y en qué estado.
5. Para todo lo que no aparezca en el inventario, revise **08** y **09**: si no existe, **no tiene contrato** y no debe inventarse.

## Leyenda de estado

| Estado                       | Significado                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------- |
| ✅ Implementado y disponible | Existe el endpoint, funciona de punta a punta y está cubierto por pruebas e2e |
| 🟡 Implementado parcialmente | Existe código o endpoint, pero falta una parte necesaria del flujo            |
| 📐 Diseñado, no implementado | Hay diseño o puntos de integración internos, pero ningún endpoint HTTP        |
| ⛔ No implementado           | No existe nada en el backend                                                  |
| ❓ Pendiente de decisión     | Depende de una decisión del docente o del equipo                              |

## Convenciones generales del backend

| Tema                  | Convención real                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL base (desarrollo) | `http://localhost:3000/api`: puerto `PORT` (por defecto 3000) y prefijo global `api`                                                                                                                                                                                                                         |
| CORS                  | Origen permitido: `CORS_ORIGIN` (por defecto `http://localhost:4200`). Métodos: GET, POST, PUT, PATCH, DELETE. Headers: `Content-Type`, `Authorization`. Sin credenciales (cookies) y sin headers expuestos.                                                                                                 |
| Autenticación         | `Authorization: Bearer <accessToken>`; no se usan cookies (ver 05)                                                                                                                                                                                                                                           |
| Formato               | JSON en cuerpo y respuesta, salvo las subidas (`multipart/form-data`) y las descargas (binario)                                                                                                                                                                                                              |
| Fechas                | Strings ISO 8601 en UTC con milisegundos, por ejemplo `"2026-11-15T14:30:00.000Z"`. El backend serializa objetos `Date` con `JSON.stringify`.                                                                                                                                                                |
| Montos                | `budgetAmount` se **envía** como string (también acepta un número JSON) y se **recibe** como string con 2 decimales, por ejemplo `"150.50"`                                                                                                                                                                  |
| Identificadores       | UUID. Los parámetros de ruta pasan por `ParseUUIDPipe`: un id que no es UUID responde 400                                                                                                                                                                                                                    |
| Horas                 | `"HH:mm"` en 24 horas (los horarios de atención admiten `"24:00"` como fin)                                                                                                                                                                                                                                  |
| Paginación            | `{ data: T[], meta: { page, limit, total, totalPages } }`. En usuarios, bitácora, pedidos, ofertas, notificaciones, listados administrativos de zona y perfiles, reclamos, diferencias de pago y calificaciones; la línea de tiempo pagina por cursor (#112); los demás listados devuelven un arreglo simple |
| Propiedades extra     | El `ValidationPipe` global usa `whitelist`, `forbidNonWhitelisted` y `transform`. **Cualquier propiedad no declarada en el DTO responde 400**: no reenvíe objetos de respuesta completos en un PATCH                                                                                                         |
| Strings de entrada    | La mayoría de los textos pasan por `@Trim()`: se recortan los espacios antes de validar                                                                                                                                                                                                                      |
| Errores               | `{ statusCode: number, message: string \| string[], error?: string }`. `message` es un **arreglo** en los errores de validación y en algunos errores de negocio (ver 03 y 09)                                                                                                                                |
| Idioma                | Los mensajes de error y de negocio están en español y se pueden mostrar al usuario; los de validación automática de class-validator mezclan el nombre del campo en inglés                                                                                                                                    |
| Serialización         | No hay interceptores globales ni `ClassSerializerInterceptor`: lo que construye el service es exactamente lo que llega                                                                                                                                                                                       |
| OpenAPI / Swagger     | **No existe**. Esta documentación es el contrato                                                                                                                                                                                                                                                             |

## Semántica de "opcional" y `null` (importante)

| Decorador en el DTO                | Omitir la propiedad | Enviar `null`                                                         | Ejemplo                   |
| ---------------------------------- | ------------------- | --------------------------------------------------------------------- | ------------------------- |
| Sin `@IsOptional` ni `@ValidateIf` | ❌ 400              | ❌ 400                                                                | `RegisterDto.email`       |
| `@IsOptional()`                    | ✅                  | ✅ (null se acepta y el service lo trata como "sin valor" o "borrar") | `UpdateUserDto.phone`     |
| `@ValidateIf(value !== undefined)` | ✅                  | ❌ 400 (null se valida y falla)                                       | `UpdateUserDto.firstName` |

En 02 se indica para cada propiedad cuál de los tres casos aplica.
