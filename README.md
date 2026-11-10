# Servicios del Hogar — Backend

## A. Descripción del proyecto

Backend de la plataforma web que conecta a personas que necesitan servicios técnicos del hogar (plomería, electricidad, albañilería, reparación de electrodomésticos, etc.) con trabajadores que ofrecen esos servicios.

Está desarrollado con **NestJS**, **TypeScript**, **PostgreSQL** y **Prisma ORM**, y sigue una arquitectura de **monolito modular**: una sola aplicación organizada en módulos funcionales independientes (por ahora `auth` y `users`).

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

### 3. Comprobar la conexión y el estado de las migraciones

```bash
npx prisma migrate status
```

Se conecta a PostgreSQL con tu `DATABASE_URL`. El resultado esperado es `Database schema is up to date!`.

### 4. Datos iniciales (seed)

Por ahora **no existe un seed** (`prisma/seed.ts`): la base de datos empieza vacía. Las cuentas se crean con el endpoint de registro (sección J).

Para probar los endpoints de administración en tu máquina, puedes dar el rol de administrador a una cuenta ya registrada. **Esto es solo para desarrollo local:**

```sql
INSERT INTO user_roles (user_id, role)
SELECT id, 'ADMINISTRADOR' FROM users WHERE email = 'tu-correo@example.com';
```

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
| `npm run lint` | Revisa el código con oxlint |
| `npm run format` | Formatea `src/` y `test/` con Prettier |
| `npm test` | Pruebas unitarias (Vitest) |
| `npm run test:e2e` | Pruebas end-to-end. **Usan la base de datos de tu `.env`**: crean cuentas de prueba (`@users-e2e.test`, `@auth-e2e.test`) y las borran al terminar. Requieren las migraciones aplicadas. |
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
| `PATCH` | `/api/users/:id/status` | Sí | Cambia el estado (`ACTIVO`, `INACTIVO`, `SUSPENDIDO`). Un usuario solo puede pasar su propia cuenta a `INACTIVO`; un administrador puede asignar cualquier estado. |

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
└── schema.prisma          # Modelos: User, UserRole y enums RoleName, UserStatus
prisma.config.ts           # Configuración de la CLI de Prisma 7 (esquema, migraciones, DATABASE_URL)

src/
├── common/                # Código compartido entre módulos (configuración global, decoradores)
├── generated/prisma/      # Cliente Prisma generado: no editar ni subir al repositorio
├── modules/               # Módulos funcionales
│   ├── auth/              # Registro, login, JWT (Passport), JwtAuthGuard, @CurrentUser
│   └── users/             # Cuentas, datos personales, estado y roles
├── prisma/                # PrismaModule y PrismaService (cliente compartido con adapter-pg)
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

### El backend no arranca por la configuración JWT

- `Configuration key "JWT_SECRET" does not exist`: falta `JWT_SECRET` en `.env`.
- `JWT_SECRET debe tener al menos 32 caracteres`: genera una clave más larga (sección F).
- `JWT_EXPIRES_IN debe ser un número de segundos o una duración...`: usa un valor como `3600`, `15m`, `1h` o `7d`.

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
