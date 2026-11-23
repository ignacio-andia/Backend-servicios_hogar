# Servicios del Hogar — Backend

## A. Descripción del proyecto

Backend de la plataforma web que conecta a personas que necesitan servicios técnicos del hogar (plomería, electricidad, albañilería, reparación de electrodomésticos, etc.) con trabajadores que ofrecen esos servicios.

Está desarrollado con **NestJS**, **TypeScript**, **PostgreSQL** y **Prisma ORM**, y sigue una arquitectura de **monolito modular**: una sola aplicación organizada en módulos funcionales independientes (por ahora `auth`, `users`, `catalogs`, `audit` y `worker-profile`).

---

## B. Tecnologías y versiones

Versiones comprobadas con las que el proyecto compila, pasa las pruebas y se ejecuta. Las dependencias de npm quedan fijadas en `package-lock.json`, así que **no hay que instalarlas a mano**.

### Programas que debe instalar cada integrante

| Programa | Versión a instalar | Versión comprobada |
|---|---|---|
| Node.js | 24 (LTS) | 24.22.2 |
| npm | 11 (se instala con Node.js) | 11.19.1 |
| PostgreSQL | 18 | 18.6 |
| Git | Cualquier versión reciente | 2.55.0 |

> Prisma 7.10.1 exige Node.js `^20.19`, `^22.12` o `>=24.0`, y NestJS 12 exige Node.js `>=20`. El equipo trabaja con **Node.js 24**: usar otra versión mayor puede funcionar, pero no está comprobado.

### Dependencias principales del proyecto (instaladas con `npm ci`)

| Paquete | Versión |
|---|---|
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `@nestjs/testing` | 12.4.2 |
| `@nestjs/cli` | 12.0.12 |
| `@nestjs/config` | 12.1.1 |
| `@nestjs/jwt` | 12.0.4 |
| `@nestjs/passport` | 12.0.1 |
| `typescript` | 6.0.3 |
| `prisma` (CLI) | 7.10.1 |
| `@prisma/client` | 7.10.1 |
| `@prisma/adapter-pg` | 7.10.1 |
| `pg` | 8.23.1 |
| `passport` | 0.7.0 |
| `passport-jwt` | 4.0.1 |
| `bcrypt` | 6.0.0 |
| `class-validator` | 0.15.1 |
| `class-transformer` | 0.5.1 |
| `sharp` (procesamiento de fotos de pedidos) | 0.35.5 |
| `@nestjs/schedule` (tareas programadas) | 12.0.4 |
| `vitest` (pruebas) | 4.1.12 |

El proyecto es **ESM** (`"type": "module"` en `package.json`): los imports relativos terminan en `.js` y las pruebas usan Vitest.

---

## C. Requisitos previos

Instala, en este orden:

1. **Git**: <https://git-scm.com/downloads>
2. **Node.js 24 LTS**, que ya incluye npm: <https://nodejs.org/en/download>
3. **PostgreSQL 18**: <https://www.postgresql.org/download/>. En Windows, el instalador incluye **pgAdmin 4** y **SQL Shell (psql)**. Anota la contraseña que definas para el usuario administrador `postgres` y deja el puerto en **5432**.

Comprueba las versiones instaladas en una terminal nueva:

```bash
git --version
```

```bash
node -v
```

```bash
npm -v
```

```bash
psql --version
```

Si `npm -v` muestra una versión anterior a la 11, actualízala a la versión comprobada:

```bash
npm install -g npm@11.19.1
```

> **Windows:** si `psql` "no se reconoce como comando", ejecútalo con su ruta completa (`"C:\Program Files\PostgreSQL\18\bin\psql.exe"`), abre **SQL Shell (psql)** desde el menú Inicio o agrega `C:\Program Files\PostgreSQL\18\bin` al `PATH`.

---

## D. Clonar el repositorio

```bash
git clone <URL_DEL_REPOSITORIO>
```

```bash
cd <CARPETA_DEL_REPOSITORIO>
```

> Reemplaza `<URL_DEL_REPOSITORIO>` por la URL de GitHub del proyecto (todavía no hay un remoto configurado en Git) y `<CARPETA_DEL_REPOSITORIO>` por la carpeta creada al clonar. Todos los comandos siguientes se ejecutan **dentro de la carpeta del backend**, que es donde están `package.json` y la carpeta `prisma/`.

---

## E. Crear la base de datos PostgreSQL

El proyecto usa estos nombres:

| Elemento | Valor |
|---|---|
| Base de datos | `servicios_hogar_db` |
| Usuario | `servicios_hogar_user` |
| Host / puerto | `localhost` / `5432` |
| Esquema | `public` |
| Contraseña | `<CONTRASEÑA_LOCAL>`, que define cada integrante en su máquina |

> **Sobre la contraseña:** es una contraseña **local de desarrollo**. No está publicada en el repositorio y no debe compartirse por canales públicos. Elige una para tu máquina (o usa la acordada internamente por el equipo) y escríbela solo en el `CREATE ROLE` de abajo y en tu archivo `.env`. Nunca uses aquí contraseñas de producción.

### 1. Abrir PostgreSQL como administrador

**Opción A: psql**

```bash
psql -U postgres -h localhost -p 5432
```

Ingresa la contraseña del usuario `postgres` que definiste al instalar PostgreSQL.

**Opción B: pgAdmin 4**

Abre pgAdmin, conéctate al servidor local (usuario `postgres`), haz clic derecho sobre la base de datos `postgres` y elige **Query Tool**.

### 2 y 3. Crear el usuario y la base de datos

Ejecuta, conectado como `postgres`:

```sql
-- Usuario de la aplicación (reemplaza <CONTRASEÑA_LOCAL>)
CREATE ROLE servicios_hogar_user WITH LOGIN PASSWORD '<CONTRASEÑA_LOCAL>';

-- Base de datos cuyo dueño es el usuario de la aplicación
CREATE DATABASE servicios_hogar_db
  WITH OWNER = servicios_hogar_user
       ENCODING = 'UTF8'
       TEMPLATE = template0;
```

> El usuario se crea antes que la base de datos porque la base de datos lo necesita como dueño.

### 4. Establecer permisos sobre la base de datos y el esquema

Conéctate a la nueva base de datos. En psql:

```sql
\c servicios_hogar_db
```

En pgAdmin, abre un **Query Tool** sobre `servicios_hogar_db`. Luego ejecuta:

```sql
GRANT ALL PRIVILEGES ON DATABASE servicios_hogar_db TO servicios_hogar_user;
GRANT ALL ON SCHEMA public TO servicios_hogar_user;
```

> Desde PostgreSQL 15, el esquema `public` pertenece a `pg_database_owner`, es decir, al dueño de la base de datos. Como `servicios_hogar_user` es el dueño, ya puede crear tablas; los `GRANT` lo dejan explícito.

> Las migraciones instalan la extensión **`citext`**, que hace que los nombres de categorías y zonas sean únicos sin distinguir mayúsculas. Viene incluida en PostgreSQL (instalador de Windows e imágenes oficiales). Como es una extensión *trusted*, el dueño de la base de datos puede instalarla sin ser superusuario. Por eso es importante que la base de datos pertenezca a `servicios_hogar_user` y que todo use el esquema `public`.

**Solo si vas a crear migraciones nuevas** (ver la sección H), dale además permiso para crear bases de datos. Prisma lo necesita para su *shadow database* temporal:

```sql
ALTER ROLE servicios_hogar_user CREATEDB;
```

Sal de psql con `\q`.

### 5. Comprobar que el usuario puede conectarse

```bash
psql -U servicios_hogar_user -h localhost -p 5432 -d servicios_hogar_db -c "SELECT current_user, current_database();"
```

Debe mostrar `servicios_hogar_user | servicios_hogar_db`. En pgAdmin, también puedes registrar una conexión nueva con ese usuario y esa base de datos.

---

## F. Configurar la conexión a PostgreSQL

1. Crea tu archivo `.env` a partir de la plantilla `.env.example`:

   PowerShell (Windows):

   ```powershell
   Copy-Item .env.example .env
   ```

   Git Bash, macOS o Linux:

   ```bash
   cp .env.example .env
   ```

2. Abre `.env` y completa los valores:

   ```env
   DATABASE_URL="postgresql://servicios_hogar_user:<CONTRASEÑA_LOCAL>@localhost:5432/servicios_hogar_db"
   JWT_SECRET="<GENERAR_CLAVE_ALEATORIA>"
   JWT_EXPIRES_IN="1h"
   ```

### `DATABASE_URL`

Formato: `postgresql://USUARIO:CONTRASEÑA@HOST:PUERTO/BASE_DE_DATOS`

| Parte | Valor del proyecto | Significado |
|---|---|---|
| `postgresql://` | — | Protocolo de PostgreSQL |
| `USUARIO` | `servicios_hogar_user` | Usuario creado en la sección E |
| `CONTRASEÑA` | `<CONTRASEÑA_LOCAL>` | Tu contraseña local de ese usuario |
| `HOST` | `localhost` | Equipo donde corre PostgreSQL |
| `PUERTO` | `5432` | Puerto de PostgreSQL |
| `BASE_DE_DATOS` | `servicios_hogar_db` | Base de datos creada en la sección E |

> Si la contraseña contiene `@ : / # ? %` u otros caracteres especiales, escríbelos codificados para URL. Por ejemplo, `@` se escribe `%40`, `#` se escribe `%23` y `%` se escribe `%25`.

### Otras variables

| Variable | Obligatoria | Descripción |
|---|---|---|
| `JWT_SECRET` | Sí | Clave para firmar los tokens JWT. **Mínimo 32 caracteres**: el backend no arranca si falta o es más corta. Cada integrante genera la suya y nunca se comparte. |
| `JWT_EXPIRES_IN` | No (por defecto `1h`) | Duración de los tokens: segundos (`3600`) o duración con unidad (`15m`, `1h`, `7d`). |
| `PORT` | No (por defecto `3000`) | Puerto HTTP del backend. |
| `FILE_STORAGE_DIR` | No (por defecto `storage/private`) | Carpeta privada donde se guardan los documentos de los trabajadores y las fotos de los pedidos. No puede estar dentro de `src/`, `public/` ni `dist/`; `/storage` ya está en `.gitignore`. |
| `WORKER_DOCUMENT_MAX_MB` | No (por defecto `5`) | Tamaño máximo de cada documento, en MB (como máximo 20). |
| `SCHEDULED_JOBS_ENABLED` | No (por defecto `true`) | `false` apaga las tareas programadas (vencimiento de pedidos y reintentos de borrado). Las pruebas e2e las apagan. |
| `FILE_DELETION_RETRY_INTERVAL_MINUTES` | No (por defecto `5`) | Cada cuánto se reintentan los archivos que no se pudieron borrar. |
| `ORDER_EXPIRATION_INTERVAL_MINUTES` | No (por defecto `15`) | Cada cuánto corre la tarea de vencimiento (también corre una vez al arrancar). El plazo de vencimiento no es configurable: son 7 días desde la publicación (T5.1). `ORDER_EXPIRATION_HOURS` ya no existe y se ignora. |
| `ORDER_MIN_IMAGES` | No (por defecto `1`) | Mínimo de fotos por pedido (como mucho 4). El **máximo es 4 y no es configurable** (T5.3): si se define `ORDER_MAX_IMAGES` con otro valor, la aplicación no arranca. Multer acepta como mucho 5 archivos, para que la quinta foto reciba el mensaje del servicio. |
| `ORDER_IMAGE_MAX_MB` | No (por defecto `10`) | Peso máximo de cada foto subida, en MB (como máximo 25). |
| `ORDER_IMAGE_MAX_PIXELS` | No (por defecto `50000000`) | Megapíxeles máximos de la foto original. |
| `ORDER_IMAGE_MAX_DIMENSION` / `ORDER_IMAGE_QUALITY` / `ORDER_THUMBNAIL_SIZE` | No (por defecto `1600` / `80` / `400`) | Lado mayor, calidad WebP y tamaño de la miniatura de las fotos guardadas. |
| `ORDER_DUPLICATE_WINDOW_DAYS` | No (por defecto `7`) | Días hacia atrás para el aviso de posible pedido duplicado. |

Para generar un `JWT_SECRET` aleatorio, ejecuta esto y copia el resultado en `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> `.env` está en `.gitignore`. **Nunca lo subas al repositorio** ni compartas su contenido.

---

## G. Instalar dependencias

```bash
npm ci
```

`npm ci` instala exactamente las versiones registradas en `package-lock.json`, incluidos NestJS, Prisma, bcrypt y las herramientas de desarrollo. Así todo el equipo trabaja con las mismas versiones. No instales esos paquetes por separado.

> Si `package-lock.json` y `package.json` no coinciden, `npm ci` se detiene con un error. En ese caso, avisa al equipo en lugar de ejecutar `npm install`, que reescribiría el lockfile.

> npm 11 puede mostrar avisos del tipo *"packages have install scripts not yet covered by allowScripts"* para `prisma`, `@prisma/engines` y `bcrypt`. Son solo avisos: el proyecto funciona con esa configuración (ver la sección L si Prisma o bcrypt fallan).

---

## H. Configurar Prisma

El proyecto usa **Prisma 7** con estas particularidades:

- La configuración de la CLI está en `prisma.config.ts`, que carga `.env` y toma `DATABASE_URL` de ahí. El esquema está en `prisma/schema.prisma` y las migraciones en `prisma/migrations/`.
- El cliente se genera en **`src/generated/prisma`**, no en `node_modules`. Esa carpeta está en `.gitignore`, así que **hay que generarla en cada copia del repositorio**.
- En tiempo de ejecución, Prisma se conecta mediante el adaptador **`@prisma/adapter-pg`**, configurado en `src/prisma/prisma.service.ts`. No requiere ninguna configuración adicional: usa la misma `DATABASE_URL`.

### 1. Generar el cliente Prisma

```bash
npx prisma generate
```

Vuelve a ejecutarlo cada vez que cambie `prisma/schema.prisma`, por ejemplo al hacer `git pull`.

### 2. Aplicar las migraciones existentes del repositorio

```bash
npx prisma migrate deploy
```

Este comando aplica, en orden, las migraciones versionadas de `prisma/migrations/` que falten en tu base de datos. **No borra datos ni reinicia la base de datos**, y es el comando correcto para una copia recién clonada y después de cada `git pull` que traiga migraciones nuevas.

| Migración | Contenido |
|---|---|
| `20261110000000_create_users_and_roles` | Usuarios y roles |
| `20261111000000_create_catalogs_and_audit_log` | Categorías, zonas, bitácora y las categorías iniciales |
| `20261111100000_case_insensitive_catalog_names` | Extensión `citext`: nombres únicos sin distinguir mayúsculas, con un máximo de 100 caracteres |
| `20261111100100_rename_appliances_category` | Renombra la categoría inicial a «Electrodomésticos» y conserva su id |
| `20261111100200_audit_log_append_only` | Trigger que impide modificar, borrar o vaciar la bitácora |
| `20261112000000_create_worker_profiles` | Perfil del trabajador, especialidades, horarios, documentos, historial de estados y solicitudes de cambio de zona, con `CHECK`, un índice único parcial y un trigger de solo inserción |
| `20261114000000_zone_change_requests_history_guard` | Protege el historial de solicitudes de cambio de zona: no se borran, una resuelta no se modifica y siempre registra la fecha y el responsable (el administrador que decidió o provocó la cancelación, o el trabajador que la retiró) |
| `20261115000000_create_orders` | Pedidos, fotos, historial de estados y cola de borrado de archivos |
| `20261122000000_audit_document_access` | Acciones de bitácora para el acceso administrativo a documentos |
| `20261122100000_create_notifications` | Notificaciones internas, con sus índices y un `CHECK` del recurso relacionado |
| `20261122200000_zone_change_cancellation` | Estado `CANCELADA` y causa de cancelación de las solicitudes de cambio de zona (con un `CHECK`), y tipos de notificación del cambio de zona |
| `20261122300000_zone_change_withdrawal` | Causa `RETIRO_TRABAJADOR` y notificación `SOLICITUD_ZONA_RETIRADA` (retiro voluntario) |
| `20261122400000_zone_reassignment_notification` | Notificación `ZONA_REASIGNADA` (reasignación administrativa de zona) |
| `20261122500000_zone_change_account_suspension` | Causa `SUSPENSION_CUENTA`: suspender una cuenta cancela su solicitud de cambio de zona pendiente |

> Algunas migraciones tienen SQL escrito a mano (conversión a `citext`, `CHECK` y triggers) porque Prisma no los genera. **No las regeneres ni las edites**: Prisma propone `DROP COLUMN`/`ADD COLUMN` para el cambio a `citext`, y eso borraría los nombres existentes.

### 3. Comprobar la conexión y el estado de las migraciones

```bash
npx prisma migrate status
```

Se conecta a PostgreSQL con tu `DATABASE_URL`. El resultado esperado es `Database schema is up to date!`.

### 4. Datos iniciales (seed)

No existe un seed aparte (`prisma/seed.ts`). La migración `20261111000000_create_catalogs_and_audit_log` carga las cuatro categorías de servicio iniciales del documento de requerimientos (Plomería, Electricidad, Albañilería y Electrodomésticos) sin duplicarlas. Las **zonas** empiezan vacías: las registra un administrador (sección J). Las cuentas se crean con el endpoint de registro, salvo el primer administrador (paso 5).

### 5. Crear el primer administrador (RF-04)

Las cuentas de administrador no se registran públicamente (RF-04): **no existe ningún endpoint** para crearlas. El primer administrador se crea **una sola vez**, con un comando interno que se ejecuta en la máquina del servidor.

**Requisitos previos**

- Pasos C a H completos: dependencias instaladas (`npm ci`), `.env` con `DATABASE_URL`, migraciones aplicadas (`npx prisma migrate deploy`) y cliente generado (`npx prisma generate`).
- No hace falta ninguna variable nueva: el comando solo usa `DATABASE_URL`. No arranca el servidor HTTP ni las tareas programadas.
- Una **terminal interactiva**: PowerShell, CMD o Windows Terminal. La contraseña se escribe sin que se vea en pantalla. En una terminal no interactiva (por ejemplo, Git Bash con mintty o una salida redirigida), el comando se detiene sin crear nada.

**Pasos en Windows 11 (PowerShell)**

```powershell
cd C:\ruta\a\servicios_hogar\backend
npm run admin:create-first
```

El comando compila el proyecto y pide:
1. Nombre.
2. Apellido.
3. Correo electrónico.
4. Teléfono (opcional; Enter para omitirlo).
5. La contraseña, dos veces. No se muestra al escribirla.

Se aplican las mismas reglas que en el registro público: contraseña de al menos 8 caracteres, con letras y números, y teléfono de 7 a 15 dígitos.

**Resultado**

- Se crea una cuenta `ACTIVO` con el rol `ADMINISTRADOR`. La contraseña se guarda con bcrypt, con las mismas 12 rondas que el registro.
- El comando muestra el correo y el id de la cuenta; nunca la contraseña ni su hash.
- Con esa cuenta se inicia sesión con `POST /api/auth/login`.

**Reglas de seguridad**

- Si ya existe **cualquier** cuenta con el rol `ADMINISTRADOR`, en cualquier estado, el comando termina con error y no crea nada. No sirve para crear administradores adicionales.
- Si el correo ya está registrado, no se crea otra cuenta ni se convierte la existente en administrador.
- Si se ejecuta dos veces a la vez, solo una ejecución crea la cuenta: un bloqueo de PostgreSQL serializa la comprobación y la creación.
- La contraseña **no** se acepta por argumentos ni variables de entorno, para que no quede en el historial de comandos. Tampoco se guarda en archivos ni aparece en la salida.
- El comando nunca se ejecuta al arrancar el servidor.
- Para corregir un error (por ejemplo, un correo mal escrito) no existe todavía un mecanismo para gestionar administradores: hay que hacerlo manualmente en la base de datos.

### Crear migraciones nuevas (solo quien modifica el esquema)

Esto **no forma parte de la configuración inicial**. Solo se hace cuando alguien cambia `prisma/schema.prisma`:

```bash
npx prisma migrate dev --name descripcion_del_cambio
```

- Requiere que `servicios_hogar_user` tenga el permiso `CREATEDB` (sección E, paso 4).
- Sube la carpeta de la migración generada junto con el cambio del esquema.
- **No uses** `npx prisma migrate reset` ni `npx prisma db push`: borran o desincronizan los datos y el historial de migraciones.

---

## I. Ejecutar el backend

Modo desarrollo, que recompila al guardar cambios:

```bash
npm run start:dev
```

El backend queda disponible en **<http://localhost:3000>** (o en el puerto definido en `PORT`). Todas las rutas usan el prefijo global **`/api`**.

Para comprobar que inició correctamente:

1. En la terminal debe aparecer `Found 0 errors` y luego `Nest application successfully started`.
2. Haz una petición a un endpoint protegido sin token. Debe responder `401` con `{"message":"Unauthorized","statusCode":401}`, lo que confirma que el servidor está escuchando:

   ```bash
   curl http://localhost:3000/api/auth/me
   ```

   > En Windows PowerShell 5.1, usa `curl.exe` en lugar de `curl`.

### Otros comandos disponibles

| Comando | Descripción |
|---|---|
| `npm run start` | Inicia sin modo watch |
| `npm run start:debug` | Inicia con depurador y watch |
| `npm run build` | Compila a `dist/` |
| `npm run start:prod` | Ejecuta la versión compilada (`dist/main`); requiere `npm run build` |
| `npm run admin:create-first` | Crea el **primer** administrador (sección H, paso 5). Solo funciona si no existe ninguno |
| `npm run lint` | Revisa el código con oxlint |
| `npm run format` | Formatea `src/` y `test/` con Prettier |
| `npm test` | Pruebas unitarias (Vitest) |
| `npm run test:e2e` | Pruebas end-to-end. **Usan la base de datos de tu `.env`**: crean cuentas de prueba (`@users-e2e.test`, `@auth-e2e.test`, `@orders-e2e.test`, etc.) y las borran al terminar. Las fotos de prueba van a una carpeta temporal. La prueba del primer administrador crea un esquema temporal vacío (`first_admin_*`), le aplica las migraciones y lo borra al terminar: no toca los datos existentes. Requieren las migraciones aplicadas y que el usuario de la BD pueda crear esquemas. |
| `npm run test:cov` | Pruebas unitarias con cobertura |

---

## J. Endpoints disponibles

Base: `http://localhost:3000/api`. Los endpoints protegidos requieren la cabecera `Authorization: Bearer <accessToken>`, con el token que devuelven el registro o el inicio de sesión.

| Método | Ruta | JWT | Descripción y permisos |
|---|---|---|---|
| `POST` | `/api/auth/register` | No | Registro público. Crea la cuenta con el rol `CLIENTE` y devuelve `{ accessToken, tokenType, user }`. Responde `409` si el correo ya existe. |
| `POST` | `/api/auth/login` | No | Inicio de sesión. Devuelve `{ accessToken, tokenType, user }`. Responde `401` si las credenciales son inválidas y `403` si la cuenta no está activa. |
| `GET` | `/api/auth/me` | Sí | Perfil del usuario autenticado. |
| `GET` | `/api/users?page=1&limit=20` | Sí | Lista paginada de usuarios (`limit` máximo 100). **Solo administradores.** |
| `GET` | `/api/users/:id` | Sí | Consulta un usuario. El propio usuario o un administrador. |
| `PATCH` | `/api/users/:id` | Sí | Actualiza `firstName`, `lastName` o `phone`. El propio usuario o un administrador. |
| `PATCH` | `/api/users/:id/status` | Sí | Cambia el estado (`ACTIVO`, `INACTIVO`, `SUSPENDIDO`). Un usuario solo puede pasar su propia cuenta a `INACTIVO`; un administrador puede asignar cualquier estado. Suspender una cuenta cancela, en la misma transacción, su solicitud de cambio de zona pendiente (causa `SUSPENSION_CUENTA`), con bitácora y notificación. |

### Catálogos: categorías de servicio (RF-48) y zonas (RF-49)

Las rutas son iguales para categorías y zonas: cambia `categories` por `zones`. Nunca se borran registros: se desactivan, y cada creación, edición o desactivación queda en la bitácora (`admin_audit_logs`).

| Método | Ruta | JWT | Descripción y permisos |
|---|---|---|---|
| `GET` | `/api/catalogs/categories` | No | Lista pública, **solo activas**, ordenada por nombre: `[{ id, name, description }]`. |
| `GET` | `/api/catalogs/categories/:id` | No | Una categoría activa. Responde `404` si no existe o está inactiva. |
| `GET` | `/api/catalogs/admin/categories?isActive=true\|false` | Sí | Catálogo completo, activas e inactivas (el filtro es opcional). **Solo administradores.** |
| `GET` | `/api/catalogs/admin/categories/:id` | Sí | Una categoría con su estado y fechas. **Solo administradores.** |
| `POST` | `/api/catalogs/categories` | Sí | Crea una categoría activa. Body: `{ "name", "description"? }`. **Solo administradores.** |
| `PATCH` | `/api/catalogs/categories/:id` | Sí | Edita `name` y/o `description` (`null` borra la descripción). **Solo administradores.** |
| `PATCH` | `/api/catalogs/categories/:id/deactivate` | Sí | Desactiva sin borrar. Responde `409` si ya estaba inactiva. **Solo administradores.** |

- **Validación:** el nombre es obligatorio, tiene de 2 a 100 caracteres y es único sin distinguir mayúsculas, incluso frente a registros inactivos (`409`). PostgreSQL lo garantiza con un índice único sobre una columna `citext`, también ante solicitudes simultáneas. La descripción es opcional, de hasta 500 caracteres. Cualquier otro campo responde `400`.
- **Errores:** `401` sin sesión, `403` sin rol administrador, `400` para un ID que no es UUID o datos inválidos, `404` si el registro no existe.
- **Para otros módulos:** `findByIds`, `assertActive` y sus versiones transaccionales `findByIdsForShare(tx, kind, ids)` y `assertActiveForShare(tx, kind, id)`. Estas leen con `SELECT … FOR SHARE` dentro de la transacción del llamador: mientras siga abierta, nadie puede desactivar ni editar esos registros. Varios lectores no se bloquean entre sí. Los catálogos son el último eslabón del orden de bloqueos (trabajador → pedido → catálogos).

### Bitácora de administración (RF-53)

| Método | Ruta | JWT | Descripción y permisos |
|---|---|---|---|
| `GET` | `/api/audit-logs` | Sí | Consulta paginada, de lo más reciente a lo más antiguo. **Solo administradores.** |

- **Filtros opcionales:**
  - `entityType`: `CATEGORIA_SERVICIO`, `ZONA`, `PERFIL_TRABAJADOR` o `SOLICITUD_CAMBIO_ZONA`.
  - `action`: `CREACION`, `EDICION`, `DESACTIVACION`, `CAMBIO_ESTADO`, `APROBACION`, `RECHAZO`, `CONSULTA_DOCUMENTOS`, `VISUALIZACION_DOCUMENTO` o `DESCARGA_DOCUMENTO`. Las tres últimas registran el acceso de un administrador a los documentos de un trabajador (`entityId` es el id del perfil).
  - `actorId`: UUID del administrador.
  - `entityId`: UUID del registro afectado.
  - `from` y `to`: fechas ISO 8601. Una fecha sin hora se interpreta en UTC, y en `to` incluye todo ese día.
  - `page` y `limit`: `limit` admite un máximo de 100.
- **Respuesta:** `{ data: [{ id, action, entityType, entityId, details, createdAt, actor: { id, firstName, lastName, email } }], meta: { page, limit, total, totalPages } }`.
- **Inmutabilidad:** no hay endpoints para editar ni borrar. Además, PostgreSQL rechaza `UPDATE`, `DELETE` y `TRUNCATE` sobre `admin_audit_logs` mediante un trigger.

### Perfil del trabajador (RF-06, RF-07, RF-08, RF-09 y RF-13)

Todas las rutas `me` actúan sobre el perfil del usuario del JWT y exigen el rol **TRABAJADOR**; nunca reciben un id de perfil.

**Cómo se obtiene el rol TRABAJADOR:** una cuenta de cliente lo recibe al crear su perfil de trabajador, en la misma transacción (si la creación falla, no se otorga). Conserva además el rol CLIENTE (RF-02). Tener el rol **no** habilita las funciones de trabajador: para eso el perfil debe estar `APROBADO` (RF-03).

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/worker-profile` | Crea el perfil propio en estado `BORRADOR` y otorga el rol TRABAJADOR. Lo pueden usar cuentas con rol CLIENTE o TRABAJADOR. Body: `{ yearsOfExperience, description?, zoneId, categoryIds[], schedules?[] }`. Responde `409` si la cuenta ya tiene un perfil. |
| `GET` | `/api/worker-profile/me` | Perfil con zona (`isActive`, `zoneRequiresChange`), especialidades, horarios, `pendingRequirements`, `canEdit` y `canSubmit`. |
| `PATCH` | `/api/worker-profile/me` | Edita `yearsOfExperience` y `description` en `BORRADOR`, `OBSERVADO`, `RECHAZADO` o `SUSPENDIDO` (un perfil suspendido sigue suspendido). `zoneId` solo se acepta en `BORRADOR`; después responde `403`. |
| `PUT` | `/api/worker-profile/me/specialties` | Reemplaza las especialidades: `{ categoryIds[] }`, solo con categorías activas. |
| `PUT` | `/api/worker-profile/me/schedules` | Reemplaza los horarios: `{ schedules: [{ dayOfWeek, startTime: "HH:mm", endTime: "HH:mm", isActive? }] }`. Admite varios intervalos por día, sin superposiciones. |
| `POST` | `/api/worker-profile/me/submit` | Envía o reenvía a revisión desde `BORRADOR`, `OBSERVADO` o `RECHAZADO`: pasa a `PENDIENTE`. Si falta algo responde `400` con la lista. |
| `GET` | `/api/worker-profile/me/status` | Estado vigente, observación (`statusReason`) e historial de cambios. |
| `GET` | `/api/worker-profile/me/eligibility` | Indica si la cuenta puede usar funciones de trabajador (solo con perfil `APROBADO`). |
| `POST` | `/api/worker-profile/me/documents` | `multipart/form-data` con `type` (`IDENTIDAD`, `ANTECEDENTES`, `CERTIFICADO` o `REFERENCIA`) y `file` (PDF, JPG o PNG). |
| `POST` | `/api/worker-profile/me/documents/:documentId/replace` | Sube una versión nueva; la anterior queda en el historial. |
| `GET` | `/api/worker-profile/me/documents` | Documentos propios, vigentes y reemplazados. |
| `GET` | `/api/worker-profile/me/documents/:documentId/download` | Descarga autorizada de un documento propio. Un documento ajeno responde `404`. |
| `GET` | `/api/worker-profile/me/zone` | Zona actual, solicitud pendiente, `canRequestChange` y `blockers` (motivos por los que no puede pedir el cambio). |
| `POST` | `/api/worker-profile/me/zone-change-requests` | Solicita cambiar de zona: `{ toZoneId, reason }`. La zona no cambia hasta que un administrador aprueba. Solo con el perfil `APROBADO`. Responde `409` si el perfil no está aprobado, si ya hay una pendiente, si tiene pedidos u ofertas activos o si esa verificación todavía no está disponible. |
| `POST` | `/api/worker-profile/me/zone-change-requests/:requestId/withdraw` | Retira la solicitud propia `PENDIENTE` (sin cuerpo): queda `CANCELADA` con `cancellationCause: RETIRO_TRABAJADOR`. La zona no cambia. `404` si no es propia; `409` si ya se resolvió. |
| `GET` | `/api/worker-profile/me/zone-change-requests` | Historial de solicitudes y decisiones. |
| `GET` | `/api/worker-profile/admin/zone-change-requests?status&resolved&workerUserId&page&limit` | **Solo administradores.** Solicitudes con datos del trabajador, zonas involucradas y quién resolvió. `resolved=true` devuelve el historial de resoluciones. |
| `GET` | `/api/worker-profile/admin/zone-change-requests/:requestId` | **Solo administradores.** Detalle de una solicitud. |
| `PATCH` | `/api/worker-profile/admin/zone-change-requests/:requestId` | **Solo administradores.** `{ decision: "APROBADA" \| "RECHAZADA", comment? }`. `comment` es **obligatorio al rechazar** (`400` si falta o está vacío). Al aprobar, la nueva zona reemplaza a la anterior; al rechazar, se conserva. Queda en la bitácora con el estado anterior y el nuevo, y se notifica al trabajador. Un administrador no puede resolver su propia solicitud. Aprobar responde `409` si el perfil está `SUSPENDIDO` o `RECHAZADO` o si la zona solicitada fue desactivada (hay que rechazarla). |
| `GET` | `/api/worker-profile/admin/inactive-zone-profiles?zoneId=` | Perfiles cuya zona fue desactivada. **Solo administradores.** |
| `GET` | `/api/worker-profile/admin/profiles?status&zoneId&categoryId&page&limit` | **Solo administradores.** Perfiles para revisar, con los datos de la cuenta (`limit` máximo 100). Primero los enviados hace más tiempo. Nunca incluye el perfil del propio administrador. |
| `GET` | `/api/worker-profile/admin/profiles/:profileId` | **Solo administradores.** Detalle para revisar: perfil, cuenta, motivo vigente, historial con quién decidió cada cambio y `allowedDecisions`. `403` si es el perfil del propio administrador. No incluye los documentos. |
| `GET` | `/api/worker-profile/admin/profiles/:profileId/documents` | **Solo administradores.** Metadatos de los documentos del perfil (vigentes y reemplazados). Queda en la bitácora (`CONSULTA_DOCUMENTOS`). `403` si es el perfil del propio administrador. |
| `GET` | `/api/worker-profile/admin/profiles/:profileId/documents/:documentId/view` | **Solo administradores.** Abre el documento en línea (`inline`). Queda en la bitácora (`VISUALIZACION_DOCUMENTO`). `404` si el documento es de otro perfil o no existe. |
| `GET` | `/api/worker-profile/admin/profiles/:profileId/documents/:documentId/download` | **Solo administradores.** Descarga el documento (`attachment`). Queda en la bitácora (`DESCARGA_DOCUMENTO`). |
| `PATCH` | `/api/worker-profile/admin/profiles/:profileId/zone` | **Solo administradores.** `{ zoneId, justification }`. Reasigna la zona de un perfil `RECHAZADO`, `OBSERVADO`, `PENDIENTE` o `SUSPENDIDO` cuya zona actual fue desactivada: la zona nueva debe estar activa y ser distinta. La justificación es obligatoria. El perfil conserva su estado; queda en la bitácora y se notifica al trabajador. `409` en otro estado o si su zona sigue activa; `403` sobre el propio perfil. |
| `PATCH` | `/api/worker-profile/admin/profiles/:profileId/status` | **Solo administradores.** `{ status: "APROBADO" \| "OBSERVADO" \| "RECHAZADO" \| "SUSPENDIDO", reason? }`. El motivo es obligatorio y no puede estar vacío salvo al aprobar. Responde `409` si la transición no está permitida o si el perfil no cumple los requisitos para aprobarse, y `403` si el perfil es del propio administrador. Queda en el historial y en la bitácora. No cambia los roles ni el estado de la cuenta. |

- **Estados:** `BORRADOR` → `PENDIENTE` → (`APROBADO` / `OBSERVADO` / `RECHAZADO`); `OBSERVADO` y `RECHAZADO` → `PENDIENTE` (reenvío); `APROBADO` ↔ `SUSPENDIDO`. El trabajador solo puede enviar o reenviar su perfil; los demás cambios los hace un administrador con `PATCH /api/worker-profile/admin/profiles/:profileId/status`. Un perfil `PENDIENTE` solo se aprueba si sigue cumpliendo los requisitos de envío (zona y especialidades activas, teléfono, horario activo); si no, responde `409` con lo que falta. La reactivación `SUSPENDIDO` → `APROBADO` exige los mismos requisitos (T4-F1). Ambas los comprueban dentro de la transacción, con la cuenta, el perfil, la zona y las especialidades bloqueados.
- **Perfil rechazado (T3.1):** `RECHAZADO` no es terminal. El trabajador ve el motivo, corrige datos, especialidades, horarios y documentos, y reenvía con `POST /api/worker-profile/me/submit` (mismos requisitos que el primer envío). La zona sigue fija. El reenvío agrega una entrada al historial de estados y conserva la decisión anterior con su motivo; no se registra en la bitácora administrativa. No cambia los roles ni el estado de la cuenta, y el perfil no recibe pedidos hasta una nueva aprobación.
- **Perfil suspendido (T4-F7):** el trabajador puede regularizar sus datos, especialidades, horarios y documentos, pero no cambiar su zona ni enviar su perfil a revisión; sigue `SUSPENDIDO` y sin trabajos, ofertas ni asignaciones nuevas. Un administrador le reasigna la zona si fue desactivada y lo reactiva solo cuando cumple todos los requisitos.
- **Perfil rechazado, observado, pendiente o suspendido con la zona desactivada (T4.4, T4-F2 y T4-F7):** el trabajador no puede cambiar la zona ni pedir un cambio, y sin una zona activa no puede reenviar ni ser aprobado. Un administrador le asigna otra zona activa con `PATCH /api/worker-profile/admin/profiles/:profileId/zone` y una justificación obligatoria. Solo funciona si la zona actual está inactiva, nunca sobre el propio perfil, y no cambia el estado (lo conserva) ni crea una solicitud de cambio de zona. Queda en la bitácora (`EDICION` sobre `PERFIL_TRABAJADOR`, con zona anterior, nueva y justificación) y el trabajador recibe `ZONA_REASIGNADA`.
- **Documentos:** el formato se detecta por el contenido del archivo, no por su extensión. Un archivo demasiado grande responde `413` y un formato no permitido, `400`. Los archivos se guardan en `FILE_STORAGE_DIR` con nombres aleatorios y nunca se exponen sus rutas. Los administradores los consultan por las rutas `admin/profiles/:profileId/documents…`. Cada acceso exitoso queda en la bitácora; los intentos rechazados no.
- **Para otros módulos:** `WorkerProfileService.assertWorkerApproved(userId)`, `lockApprovedWorker(tx, userId)` (dentro de una transacción: bloquea al trabajador y relee su perfil aprobado), `findApprovedWorkers({ categoryId, zoneId })`, `findProfilesWithInactiveZone(zoneId?)`, `ZoneChangeRequestsService.decide(...)` y el guard `ApprovedWorkerGuard`. Para usarlos, el módulo debe importar `WorkerProfileModule`.
- **Estados que pueden pedir un cambio de zona:** solo `APROBADO` (especificación v1.0 §4, T4.2). `BORRADOR` elige la zona directamente. Lista en `ZONE_REQUEST_ALLOWED_STATUSES`.
- **Suspensión con una solicitud pendiente (T4.2):** al suspender el perfil, la solicitud pasa a `CANCELADA` con `cancellationCause: SUSPENSION_PERFIL`, en la misma transacción. No es un rechazo: la zona no cambia, `decidedBy` y `decidedAt` registran qué administrador la provocó y cuándo, queda en la bitácora (`CAMBIO_ESTADO`) y el trabajador recibe una notificación.
- **Retiro voluntario (T4.3):** el trabajador retira su solicitud pendiente. Queda `CANCELADA` con `cancellationCause: RETIRO_TRABAJADOR`; `decidedBy` y `decidedAt` registran que la retiró él y cuándo. Recibe una notificación. Como acción del trabajador, igual que el envío del perfil, no va a la bitácora administrativa: la constancia es la propia solicitud.
- **Trabajo nuevo con una solicitud pendiente (T4.3):** no puede ofertar ni recibir asignaciones nuevas (`409`): lo comprueba `WorkerProfileService.lockApprovedWorker`, que usan la asignación de pedidos y `assertOpenForOffers`. Tampoco aparece en `findApprovedWorkers`. Sus trabajos ya acordados no cambian. Al resolverse o retirarse la solicitud vuelve a participar. **Pendiente:** el módulo de ofertas debe usar `assertOpenForOffers` y registrar la fuente `OFERTAS`.
- **Cambio de zona y trabajo activo:** el trabajador no puede pedir un cambio de zona mientras tenga pedidos u ofertas activos. Hoy cuentan los pedidos asignados en `ACORDADO` y estados posteriores, hasta `EN_RECLAMO` (`ACTIVE_ORDER_STATUSES`, pendiente con el docente). Como todavía no hay salida desde `ACORDADO` (RF-34 y cierre pendientes), un trabajador con un acuerdo queda bloqueado para cambiar de zona hasta que esos módulos existan. OrdersModule ya registra la fuente `PEDIDOS`; el módulo de ofertas todavía no existe, así que **la solicitud sigue bloqueada** (`blockers: VERIFICACION_NO_DISPONIBLE`) hasta que registre la fuente `OFERTAS` en `WorkerActiveWorkRegistry`, exportado por `WorkerProfileModule`.
- **Integración de ofertas:**
  1. Registrar la consulta `OFERTAS` en `onModuleInit`: `registry.register({ kind: ActiveWorkKind.OFERTAS, countActive: (workerUserId, db) => db.<modelo>.count({ ... }) })`. Debe leer con `db`, la transacción que recibe. La fuente `PEDIDOS` ya la registra OrdersModule. Al registrar la fuente real, la prueba e2e de worker-profile que hoy registra una fuente `OFERTAS` de prueba debe ajustarse.
  2. **Orden de bloqueos: primero el trabajador, después el pedido.** Al crear una oferta, usar `OrderVisibilityService.assertOpenForOffers(tx, workerUserId, orderId)`, que respeta ese orden. Para asignar, `OrdersService.transition(...)` también lo respeta. Ningún hook de pedido puede llamar a `lockWorker`.
- **Pendiente del docente:** si aprobar un cambio de zona devuelve el perfil a revisión (hoy no) y si al aprobar se vuelve a verificar el trabajo activo (implementado pero desactivado: `recheckActiveWorkOnApproval`). Todo está centralizado en `ZONE_CHANGE_POLICY` y en `ZoneChangeRequestsService.applyApprovedChange`.

### Notificaciones internas (T3.2)

| Método | Ruta | JWT | Descripción y permisos |
|---|---|---|---|
| `GET` | `/api/notifications` | Sí | Notificaciones propias, de la más reciente a la más antigua. Query: `unread` (`true` o `false`, opcional), `page`, `limit` (máximo 100). |
| `GET` | `/api/notifications/unread-count` | Sí | `{ unread }`: cantidad de notificaciones propias no leídas. |
| `PATCH` | `/api/notifications/:notificationId/read` | Sí | Marca una notificación propia como leída (idempotente). `404` si es ajena o no existe. |
| `PATCH` | `/api/notifications/read-all` | Sí | Marca como leídas todas las propias. Responde `{ updated }`. |

- **Solo internas:** se guardan en la tabla `notifications`. No hay correo, SMS ni push, y no se borran automáticamente.
- **Permisos:** cualquier cuenta `ACTIVO`, con cualquier rol. El destinatario sale siempre del token: no se acepta `userId`.
- **Respuesta:** `{ id, type, title, message, resourceType, resourceId, readAt, createdAt }`. El listado usa `{ data, meta: { page, limit, total, totalPages } }`.
- **Eventos integrados:** cada decisión administrativa sobre un perfil notifica al trabajador (`PERFIL_APROBADO`, `PERFIL_OBSERVADO`, `PERFIL_RECHAZADO`, `PERFIL_SUSPENDIDO`, `PERFIL_REACTIVADO`, con el motivo). Cada envío a verificación notifica a los administradores activos, salvo a quien envía (`VERIFICACION_SOLICITADA`, `VERIFICACION_REENVIADA_OBSERVACION`, `VERIFICACION_REENVIADA_RECHAZO`, sin datos personales).
- **Consistencia:** la notificación se crea en la misma transacción que el evento. Si falla, el cambio de estado o el envío tampoco se guarda.
- **Para otros módulos:** importe `NotificationsModule` y use `NotificationsService.create(userId, notificacion, tx)` o `createForRole(rol, notificacion, { excludeUserIds }, tx)`. El texto lo arma el módulo que origina el evento.
- **Cambio de zona (T4.2):** el trabajador recibe `SOLICITUD_ZONA_APROBADA`, `SOLICITUD_ZONA_RECHAZADA` (con el motivo) o `SOLICITUD_ZONA_CANCELADA` (al suspender su perfil), en la misma transacción que la decisión, y `SOLICITUD_ZONA_RETIRADA` al retirarla (T4.3).
- **Pendientes:** notificaciones de pedidos, ofertas, visitas y reclamos.

### Pedidos (RF-14 a RF-18)

Las rutas `me` son del cliente dueño del pedido y exigen el rol **CLIENTE**; un pedido ajeno responde `404`. Las rutas `available` son para trabajadores con perfil **APROBADO**.

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/orders` | Publica un pedido (`multipart/form-data`): `categoryId`, `zoneId`, `description` (10 a 2000 caracteres), `budgetAmount` (mayor que 0, hasta 2 decimales), `addressLine`, `addressReference?` y de 1 a 4 fotos en el campo `images`. Queda `PUBLICADO` y vence a los 7 días de su publicación (T5.1). Devuelve `{ order, warnings }`. |
| `POST` | `/api/orders/duplicate-check` | Aviso orientativo antes de publicar: `{ categoryId, zoneId, description }` → `{ warnings }`. Nunca bloquea. |
| `GET` | `/api/orders/me?status&page&limit` | Pedidos propios, del más reciente al más antiguo (`limit` máximo 50). |
| `GET` | `/api/orders/me/:orderId` | Detalle propio con dirección, fotos, `canEdit` y `canCancel`. |
| `PATCH` | `/api/orders/me/:orderId` | Edita `categoryId`, `description`, `budgetAmount`, `addressLine` y/o `addressReference` (`null` la borra). La categoría nueva debe existir y estar activa; el pedido pasa a verse en esa categoría. La zona no se edita (cancelar y crear otro pedido). No cambia el estado, las fechas ni las ofertas existentes. |
| `POST` | `/api/orders/me/:orderId/images` | Agrega una foto (campo `image`). `201` con el pedido actualizado; `409` si ya tiene el máximo. |
| `PUT` | `/api/orders/me/:orderId/images/:imageId` | Reemplaza una foto (campo `image`); la anterior se borra del disco. `200` con el pedido actualizado. |
| `DELETE` | `/api/orders/me/:orderId/images/:imageId` | Borra una foto del disco. `200` con el pedido actualizado (nueva `revision` y vencimiento); `409` si quedaría por debajo del mínimo (hay que reemplazarla). |
| `POST` | `/api/orders/me/:orderId/cancel` | Cancela: `{ reason? }` (hasta 500 caracteres). `200` con el pedido. Borra todas las fotos y conserva el pedido y su historial. |
| `GET` | `/api/orders/me/:orderId/images/:imageId?variant=full\|thumb` | Descarga una foto propia. |
| `GET` | `/api/orders/available?categoryId&page&limit` | Pedidos visibles para el trabajador: misma zona, categoría entre sus especialidades, `PUBLICADO` o `EN_NEGOCIACION` sin vencer, zona y categoría activas, cuenta del cliente `ACTIVO`, y nunca los suyos como cliente (RN-14). Sin dirección ni datos del cliente. |
| `GET` | `/api/orders/available/:orderId` | Detalle con la misma regla. Un pedido no visible responde `404`. |
| `GET` | `/api/orders/available/:orderId/images/:imageId?variant=full\|thumb` | Foto de un pedido visible. |

- **Edición:** solo en `PUBLICADO` o `EN_NEGOCIACION` y antes de vencer.
  - Toda edición efectiva sube `revision` y actualiza `lastEditedAt`. Agregar, reemplazar o borrar una foto también cuenta como edición.
  - Una edición sin cambios reales no sube la revisión.
- **Vencimiento (T5.1):** todo pedido vence a los **7 días calendario** desde su publicación original (`expiresAt = publishedAt + 7 días`, reloj de la BD). Ese plazo no se reinicia nunca: ni al editar, ni al cambiar de estado, ni al volver a `PUBLICADO` después de una negociación fallida, y no depende de las ofertas. También vence en `EN_NEGOCIACION`. Pasado `expiresAt`, las respuestas ya lo muestran `VENCIDO` y no se puede editar, cancelar, ofertar ni cambiarle el estado, aunque la tarea automática no haya corrido. La tarea corre al arrancar y cada `ORDER_EXPIRATION_INTERVAL_MINUTES`, toma los pedidos con `FOR UPDATE SKIP LOCKED` (nunca vence dos veces el mismo) y deja el historial con actor `SISTEMA`. El evento `VENCIDO` de `OrderLifecycleRegistry` incluye `fromStatus`.
  - Con acuerdo (`ACORDADO` en adelante), editar o cancelar responde `409` e indica usar «Cancelar trabajo» (RF-34). Un pedido vencido responde `409`.
- **Avisos (`warnings`):**
  - `POSIBLE_DUPLICADO`: pedido activo parecido del mismo cliente, categoría y zona en los últimos 7 días.
  - `POSIBLE_DATO_PERSONAL`: teléfono o correo en la descripción.
  - Ninguno de los dos bloquea la operación.
- **Fotos:**
  - Se aceptan JPG, PNG y WebP, de hasta 10 MB y 50 megapíxeles. El formato se detecta por el contenido.
  - Se guardan como WebP sRGB (máximo 1600 px, calidad 80, más una miniatura), sin EXIF, GPS ni perfil ICC, con nombres aleatorios.
  - Una foto demasiado grande responde `413`.
- **Vencimiento:**
  - Una tarea cada 15 minutos marca `VENCIDO` los pedidos `PUBLICADO` cuyo plazo pasó y deja el historial con actor `SISTEMA` (`VENCIMIENTO`).
  - Cada pedido se vence en su propio `SAVEPOINT` (transacción anidada de Prisma). Si un hook falla, solo ese pedido queda sin vencer; se registra en el log y se reintenta en la siguiente pasada.
  - Las consultas ya tratan como vencido un pedido atrasado aunque la tarea no haya corrido.
  - Las fotos de pedidos vencidos se conservan.
- **Historial:** cada cambio de estado queda en `order_status_history`, protegida contra `UPDATE`, `DELETE` y `TRUNCATE` por un trigger.
- **Para otros módulos (ofertas, pagos, etc.):**
  - `OrdersService.transition(tx, request: OrderTransitionRequest)` (`src/modules/orders/order-transition.ts`):
    - API tipada: las combinaciones inválidas no compilan. `CANCELADO` y `VENCIDO` no son destinos públicos; `ACORDADO` exige `assignWorkerId`; los demás estados con acuerdo conservan el trabajador; los estados sin acuerdo no asignan y pueden liberar (`releaseWorker`).
    - Un uso inválido forzado con conversiones de tipo lanza `OrderTransitionUsageError`: es un error de programación (500) y no se convierte en 400 ni 409. Las reglas de negocio responden `403`, `404` o `409`.
    - Valida contra `ORDER_TRANSITIONS`.
    - Estado, asignación del trabajador e historial se escriben en la transacción del llamador: o se confirma todo o nada.
    - Bloquea primero al trabajador (y relee su perfil aprobado) y después el pedido.
  - Transiciones habilitadas para ofertas:
    - `PUBLICADO → EN_NEGOCIACION`: primera oferta.
    - `EN_NEGOCIACION → ACORDADO`: exige `assignWorkerId`, un trabajador aprobado distinto del cliente.
    - `EN_NEGOCIACION → PUBLICADO`: conserva el vencimiento original (T5.1); con `releaseWorker` libera la asignación.
    - `SIN_ACUERDO` y la salida desde `ACORDADO` siguen pendientes con el docente.
  - `OrderVisibilityService.assertOpenForOffers(tx, workerUserId, orderId)`: dentro de la transacción del llamador, bloquea y relee al trabajador, bloquea el pedido, lee zona y categorías con `FOR SHARE` (`CatalogsService`) y aplica la misma regla de visibilidad. Devuelve `{ worker, order }`.
  - `create()` también vuelve a validar la zona y la categoría dentro de su transacción, con `FOR SHARE`.
  - **Decisión pendiente del equipo:** qué pasa con las ofertas ya enviadas cuando se desactiva la zona o la categoría, o se suspende al cliente. Hoy solo se impide **ofertar**; no se cambia ninguna oferta existente.
  - `OrderLifecycleRegistry.register({ name, inTransaction?, afterCommit? })` recibe los eventos `EDITADO`, `CANCELADO` y `VENCIDO` (con `fromStatus`: `PUBLICADO` o `EN_NEGOCIACION`).
  - OrdersModule registra la fuente `PEDIDOS` en `WorkerActiveWorkRegistry`: pedidos asignados en estados activos.
- **Pendiente del docente:** todo está centralizado en `src/modules/orders/orders.rules.ts` y `orders.config.ts`.
  - Cuándo se llega a `SIN_ACUERDO` y cómo se sale de `ACORDADO` (RF-34).
  - Qué estados cuentan como activos.
  - Visibilidad de la dirección exacta.
  - Si se pueden editar categoría o zona.
  - Soporte de HEIC (la cantidad ya está definida: hasta 4 fotos).
  - Edición en negociación frente a ofertas existentes.
  - Retención de fotos de pedidos vencidos.

Ejemplo de registro:

```json
POST /api/auth/register
{
  "firstName": "Juan",
  "lastName": "Pérez",
  "email": "juan@example.com",
  "password": "Password123",
  "phone": "70000000"
}
```

La contraseña debe tener **al menos 8 caracteres, una letra y un número**. Las respuestas nunca incluyen la contraseña ni su hash.

---

## K. Estructura del proyecto

```text
prisma/
├── migrations/            # Migraciones versionadas (Prisma Migrate)
└── schema.prisma          # Modelos y enums (usuarios, catálogos, perfiles, pedidos, etc.)
prisma.config.ts           # Configuración de la CLI de Prisma 7 (esquema, migraciones, DATABASE_URL)

src/
├── common/                # Código compartido entre módulos (configuración global, decoradores)
├── generated/prisma/      # Cliente Prisma generado: no editar ni subir al repositorio
├── modules/               # Módulos funcionales
│   ├── audit/             # Bitácora de acciones administrativas: registro y consulta (solo administradores)
│   ├── auth/              # Registro, login, JWT (Passport), JwtAuthGuard, RolesGuard, @Auth, @CurrentUser
│   ├── catalogs/          # Categorías de servicio y zonas de Cochabamba
│   ├── notifications/     # Notificaciones internas: bandeja del usuario y servicio para los demás módulos
│   ├── orders/            # Pedidos: publicación, fotos, visibilidad, edición, cancelación y vencimiento
│   ├── users/             # Cuentas, datos personales, estado y roles
│   └── worker-profile/    # Perfil del trabajador, documentos, estados y zona fija
├── prisma/                # PrismaModule y PrismaService (cliente compartido con adapter-pg)
├── storage/               # StorageModule: archivos privados (FileStorage) y cola de borrado (FileDeletionService)
├── app.module.ts          # Módulo raíz: registra ConfigModule y los módulos funcionales
└── main.ts                # Punto de entrada: prefijo /api, validación global, puerto

test/                      # Pruebas end-to-end
```

### Convenciones de la arquitectura modular

Cada módulo funcional vive en `src/modules/<nombre-del-modulo>/` y separa responsabilidades:

- **`*.controller.ts`**: recibe las peticiones HTTP, valida la entrada mediante DTO y delega en el servicio. No contiene lógica de negocio ni consultas a Prisma.
- **`*.service.ts`**: contiene la lógica de negocio, accede a la base de datos mediante el `PrismaService` compartido y lanza excepciones de NestJS.
- **`dto/`**: clases con decoradores de `class-validator` que definen y validan los datos de entrada. La validación global rechaza las propiedades no declaradas.
- **`*.module.ts`**: declara controllers y providers, importa lo que necesita y exporta los servicios que otros módulos usan.

Un módulo usa a otro solo a través de los servicios que este exporta. Por ejemplo, `AuthModule` usa `UsersService` y nunca consulta la tabla de usuarios directamente. No se crean instancias propias de `PrismaClient`.

---

## L. Solución de problemas frecuentes

### Error de conexión a PostgreSQL (`ECONNREFUSED`, `Can't reach database server`)

- Comprueba que el servicio de PostgreSQL esté iniciado:

  ```bash
  pg_isready -h localhost -p 5432
  ```

  Debe responder `aceptando conexiones` o `accepting connections`. En Windows, revisa en **Servicios** (`services.msc`) que `postgresql-x64-18` esté en ejecución.
- Verifica que el host y el puerto de `DATABASE_URL` sean `localhost` y `5432`.

### Usuario o contraseña incorrectos (`password authentication failed for user "servicios_hogar_user"`)

- Revisa la contraseña en `DATABASE_URL` y recuerda codificar los caracteres especiales (sección F).
- Si no la recuerdas, restablécela conectado como `postgres`:

  ```sql
  ALTER ROLE servicios_hogar_user WITH PASSWORD '<CONTRASEÑA_LOCAL>';
  ```

- Si el usuario no existe (`role "servicios_hogar_user" does not exist`), repite la sección E.

### Base de datos inexistente (`database "servicios_hogar_db" does not exist`)

Crea la base de datos (sección E, pasos 2 a 4) y luego aplica las migraciones con `npx prisma migrate deploy`.

### Error al generar o usar Prisma Client

- `Cannot find module '.../generated/prisma/client.js'` o errores de TypeScript sobre los modelos: ejecuta `npx prisma generate`.
- Comprueba que el esquema sea válido:

  ```bash
  npx prisma validate
  ```

- Si Prisma no encuentra su motor (*schema engine*) o bcrypt falla al cargar después de `npm ci` con avisos de `allowScripts`, revisa los scripts pendientes y autoriza los de estos paquetes:

  ```bash
  npm install-scripts ls
  ```

  ```bash
  npm install-scripts approve @prisma/engines prisma bcrypt
  ```

  Después vuelve a ejecutar `npm ci`. Como este comando modifica la configuración del proyecto, coordínalo con el equipo.

### Migraciones pendientes

`npx prisma migrate status` indica que hay migraciones sin aplicar, o la aplicación falla con errores como `relation "users" does not exist` o `The table public.users does not exist`. Aplica las migraciones:

```bash
npx prisma migrate deploy
```

### `P3014: Prisma Migrate could not create the shadow database`

Aparece al ejecutar `prisma migrate dev`. Al usuario le falta el permiso `CREATEDB` (sección E, paso 4). Para configurar el proyecto no hace falta `migrate dev`: usa `migrate deploy`.

> **Estado actual:** el `servicios_hogar_user` de la máquina donde se desarrollaron los módulos **no tiene `CREATEDB`**. Por eso las migraciones de catálogos y bitácora se generaron con `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` y se aplicaron con `migrate deploy`. Para que `migrate dev` funcione, una persona con acceso al usuario `postgres` debe ejecutar `ALTER ROLE servicios_hogar_user CREATEDB;`.

### `extension "citext" is not available` o `permission denied to create extension "citext"`

- `citext` viene en el paquete *contrib* de PostgreSQL. Si no está disponible, reinstala PostgreSQL 18 con el instalador oficial.
- Si falta el permiso, la base de datos no pertenece a `servicios_hogar_user`. Corrígelo como `postgres` con `ALTER DATABASE servicios_hogar_db OWNER TO servicios_hogar_user;` y vuelve a ejecutar `npx prisma migrate deploy`.

### `La bitácora de administración es de solo inserción`

Es intencional: un trigger impide modificar o borrar registros de `admin_audit_logs` (RF-53) y de `worker_profile_status_history` (RF-08). Para limpiar datos de pruebas, las pruebas e2e activan el ajuste `app.audit_maintenance` solo dentro de su transacción (ver `test/utils/audit-maintenance.ts`). No lo uses en la aplicación.

### El backend no arranca por la configuración JWT

- `Configuration key "JWT_SECRET" does not exist`: falta `JWT_SECRET` en `.env`.
- `JWT_SECRET debe tener al menos 32 caracteres`: genera una clave más larga (sección F).
- `JWT_EXPIRES_IN debe ser un número de segundos o una duración...`: usa un valor como `3600`, `15m`, `1h` o `7d`.

### Fechas corridas 4 horas o pedidos que vencen antes de tiempo

`PrismaService` abre las conexiones con la zona horaria de sesión en **UTC** (`-c TimeZone=UTC`), porque el adaptador `@prisma/adapter-pg` envía y lee las fechas sin zona. Así las fechas se guardan bien y `now()` de PostgreSQL coincide con la aplicación, aunque la base de datos esté configurada en `America/La_Paz`. No quites esa opción. Los registros creados antes de este cambio pueden tener la hora corrida; no se corrigieron (decisión del equipo).

### Puerto 3000 ocupado (`EADDRINUSE: address already in use :::3000`)

- Define otro puerto en `.env`, por ejemplo `PORT=3001`.
- O identifica y cierra el proceso que ocupa el puerto.

  En Windows:

  ```powershell
  netstat -ano | findstr :3000
  ```

  ```powershell
  taskkill /PID <PID> /F
  ```

  En macOS o Linux:

  ```bash
  lsof -i :3000
  ```

### Dependencias incompatibles o errores extraños tras actualizar el repositorio

- Comprueba que usas **Node.js 24** y **npm 11** (`node -v`, `npm -v`).
- Reinstala desde cero con las versiones del lockfile: borra la carpeta `node_modules` y ejecuta `npm ci`. Después ejecuta `npx prisma generate`.
- `npm ci` falla porque `package.json` y `package-lock.json` no coinciden: no ejecutes `npm install` para "arreglarlo"; avisa al equipo para corregir el lockfile en el repositorio.
- No actualices paquetes por tu cuenta (`npm update`, `npm install paquete@latest`): los cambios de versión se acuerdan en equipo.
