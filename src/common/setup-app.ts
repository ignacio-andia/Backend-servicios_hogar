import { INestApplication, ValidationPipe } from '@nestjs/common';

export const GLOBAL_PREFIX = 'api';

/** Origen del frontend Angular en desarrollo (ng serve). */
export const DEFAULT_CORS_ORIGIN = 'http://localhost:4200';

/**
 * Orígenes autorizados a llamar a la API desde el navegador.
 * CORS_ORIGIN admite varios separados por coma; si no se define, se usa
 * el del frontend local.
 */
export function parseCorsOrigins(value: string | undefined): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : [DEFAULT_CORS_ORIGIN];
}

export function setupApp(app: INestApplication): void {
  app.setGlobalPrefix(GLOBAL_PREFIX);
  // El frontend se sirve desde otro origen. La autenticación viaja en el
  // encabezado Authorization (sin cookies), por lo que no se habilitan credenciales.
  app.enableCors({
    origin: parseCorsOrigins(process.env.CORS_ORIGIN),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
