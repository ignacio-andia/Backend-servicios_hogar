# 06. Contratos de archivos

## Resumen

| | Documentos del trabajador | Fotos de pedidos |
|---|---|---|
| Subir | `POST /api/worker-profile/me/documents` | Al crear: `POST /api/orders`. Agregar: `POST /api/orders/me/:orderId/images` |
| Reemplazar | `POST /api/worker-profile/me/documents/:documentId/replace` | `PUT /api/orders/me/:orderId/images/:imageId` |
| Borrar | **No existe** (el reemplazo conserva el anterior en el historial) | `DELETE /api/orders/me/:orderId/images/:imageId` |
| Descargar | `GET /api/worker-profile/me/documents/:documentId/download` | Dueño: `GET /api/orders/me/:orderId/images/:imageId?variant=`. Trabajador aprobado: `GET /api/orders/available/:orderId/images/:imageId?variant=` |
| Content-Type de la subida | `multipart/form-data` | `multipart/form-data` |
| Campos | `type` (texto) y `file` (1 archivo). El reemplazo usa solo `file` | Crear: los campos de `CreateOrderDto` y `images` (1 a 3 archivos). Agregar o reemplazar: `image` (1 archivo) |
| Formatos aceptados | PDF, JPG o PNG, detectados por el **contenido** (firma de bytes), no por la extensión ni por el Content-Type | JPEG, PNG o WebP, detectados por el contenido con `sharp` (GIF, HEIC u otros responden 400) |
| Tamaño máximo | 5 MB por defecto (`WORKER_DOCUMENT_MAX_MB`, tope 20) | 10 MB por foto (`ORDER_IMAGE_MAX_MB`, tope 25) y 50 megapíxeles |
| Cantidad | 1 por petición | Al crear, 1 a 3 (`ORDER_MIN_IMAGES` y `ORDER_MAX_IMAGES`). Total del pedido entre el mínimo y el máximo |
| Procesamiento | Se guarda tal cual, con nombre aleatorio | Se reorienta según EXIF, se convierte a **WebP sRGB** (máximo 1600 px de lado, calidad 80) más una miniatura de 400 px. Se eliminan EXIF, GPS, XMP e ICC |
| Estado requerido | Perfil `BORRADOR` u `OBSERVADO` para subir o reemplazar (409). Descargar en cualquier estado | Pedido `PUBLICADO` (sin vencer) o `EN_NEGOCIACION` para subir, reemplazar o borrar (409) |
| Respuesta de la subida | `WorkerDocumentView` (201) | Crear: `OrderWithWarnings` (201). Agregar: `OwnerOrderView` (201). Reemplazar: `OwnerOrderView` (200). Borrar: `OwnerOrderView` (200) |

## Errores

| Situación | Documentos | Fotos |
|---|---|---|
| Archivo ausente o vacío | 400 `"Debe adjuntar un archivo no vacío en el campo \"file\""` | Crear: 400 por cantidad. Agregar o reemplazar sin archivo: 400 `"Debe adjuntar una fotografía en el campo \"image\""`. Archivo vacío: 400 `"Cada fotografía debe ser un archivo de imagen no vacío"` |
| Formato no permitido | 400 `"Formato de archivo no permitido. Formatos aceptados: PDF, JPG, PNG"` | 400 `"Formato de imagen no permitido. Formatos aceptados: JPG, PNG, WebP"` |
| Imagen dañada | — | 400 `"El archivo no es una imagen válida o está dañado"` |
| Demasiados píxeles | — | 400 `"La imagen supera el máximo de 50 megapíxeles"` |
| Archivo demasiado grande | **413** `"El archivo supera el tamaño máximo permitido de 5 MB"` | **413** `"Cada fotografía puede pesar como máximo 10 MB"` |
| Cantidad de fotos al crear | — | 400 `"Debe adjuntar entre 1 y 3 fotografías en el campo \"images\""`; más de 10 archivos: 400 de multer (en inglés) |
| Máximo de fotos al agregar | — | 409 `"El pedido ya tiene el máximo de 3 fotografías. Elimine o reemplace una."` |
| Mínimo de fotos al borrar | — | 409 `"El pedido debe conservar al menos 1 fotografía(s). Use reemplazar."` |
| Documento ya reemplazado | 409 | — |
| Recurso ajeno o inexistente | 404 | 404 |

Si la operación falla después de guardar el archivo (por ejemplo, un error de la BD), el backend borra el archivo o lo deja en una cola de reintento. **No quedan archivos visibles sin registro.**

## Descargas

| | Documento | Foto |
|---|---|---|
| Content-Type | El `mimeType` original | `image/webp` |
| Content-Disposition | `attachment; filename="…"; filename*=UTF-8''…` | `inline` |
| Caché | `Cache-Control: private, no-store` | ídem |
| Otros | `X-Content-Type-Options: nosniff`, `Content-Length` | ídem |
| Variantes | — | `variant=full` (por defecto) o `variant=thumb` |

## Protección de archivos privados

- Los archivos se guardan en una carpeta privada (`FILE_STORAGE_DIR`) con nombres aleatorios. **Ninguna respuesta expone rutas ni claves de almacenamiento.**
- Solo se descargan por las rutas autorizadas anteriores, que verifican el token, el rol y la pertenencia o visibilidad. Un recurso que no corresponde responde 404.
- Las fotos de un pedido cancelado se borran físicamente. Las de un pedido vencido se conservan (❓ retención pendiente con el docente).
- Los administradores **no** pueden descargar documentos de trabajadores: no hay endpoint (RF-56 pendiente).

## Implicaciones para Angular

1. **No use `<img src="/api/...">` ni enlaces directos.** Las descargas exigen el header `Authorization`, que el navegador no envía en `<img>` ni `<a href>`. Use:
   ```ts
   this.http.get(url, { responseType: 'blob' })
   ```
   y luego `URL.createObjectURL(blob)` (con `DomSanitizer` si hace falta). Libere la URL con `URL.revokeObjectURL` al destruir el componente.
2. **Miniaturas:** pida `variant=thumb` para las listas y `full` para el detalle. `OrderImageView` trae `width`, `height` y los tamaños, para reservar el espacio.
3. **Nombre del archivo descargado:** `Content-Disposition` no es legible (CORS no expone headers). Use `WorkerDocumentView.originalName` para `a.download`.
4. **FormData:** construya un `FormData`; no fije el header `Content-Type`, porque el navegador agrega el `boundary`.
   ```ts
   const form = new FormData();
   form.append('categoryId', v.categoryId);
   form.append('zoneId', v.zoneId);
   form.append('description', v.description);
   form.append('budgetAmount', v.budgetAmount);   // string, por ejemplo '150.50'
   form.append('addressLine', v.addressLine);
   if (v.addressReference) form.append('addressReference', v.addressReference);
   files.forEach((f) => form.append('images', f)); // mismo nombre de campo repetido
   this.http.post<OrderWithWarnings>('/api/orders', form);
   ```
   Documentos: `form.append('type', 'IDENTIDAD'); form.append('file', file)`. No agregue otros campos: responden 400 (`forbidNonWhitelisted`).
5. **Validación previa en el cliente:** tipo MIME aproximado (`accept="image/jpeg,image/png,image/webp"` o `application/pdf,image/jpeg,image/png`), tamaño y cantidad. El backend vuelve a validar por el contenido real.
6. **Progreso:** use `reportProgress: true, observe: 'events'` para las subidas grandes.
7. **Errores 413:** tienen el mismo formato `ApiError` y un mensaje en español listo para mostrar.
