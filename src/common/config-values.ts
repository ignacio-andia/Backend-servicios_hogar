import { ConfigService } from '@nestjs/config';

/**
 * Lee un entero positivo de la configuracion con un valor por defecto y un
 * rango permitido. Un valor invalido detiene el arranque con un mensaje claro.
 */
export function readPositiveInt(
  config: ConfigService,
  key: string,
  defaultValue: number,
  {
    min = 1,
    max = Number.MAX_SAFE_INTEGER,
  }: { min?: number; max?: number } = {},
): number {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

/**
 * Tareas programadas (vencimiento de pedidos, reintentos de borrado). Se
 * apagan con SCHEDULED_JOBS_ENABLED=false, por ejemplo en las pruebas e2e.
 */
export function scheduledJobsEnabled(config: ConfigService): boolean {
  return config.get<string>('SCHEDULED_JOBS_ENABLED', 'true') !== 'false';
}
