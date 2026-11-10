import { INestApplication, ValidationPipe } from '@nestjs/common';

export const GLOBAL_PREFIX = 'api';

export function setupApp(app: INestApplication): void {
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
