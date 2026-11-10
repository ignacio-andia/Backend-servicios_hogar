import { ConfigService } from '@nestjs/config';
import type { JwtSignOptions } from '@nestjs/jwt';

export const JWT_ALGORITHM = 'HS256';
export const JWT_SECRET_MIN_LENGTH = 32;
export const DEFAULT_JWT_EXPIRES_IN = '1h';

const EXPIRES_IN_PATTERN = /^[1-9]\d*(ms|s|m|h|d|w)?$/;

export function getJwtSecret(config: ConfigService): string {
  const secret = config.getOrThrow<string>('JWT_SECRET');
  if (secret.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(
      `JWT_SECRET debe tener al menos ${JWT_SECRET_MIN_LENGTH} caracteres`,
    );
  }
  return secret;
}

/** Acepta segundos (`3600`) o una duración con unidad (`15m`, `1h`, `7d`). */
export function getJwtExpiresIn(
  config: ConfigService,
): NonNullable<JwtSignOptions['expiresIn']> {
  const value = config
    .get<string>('JWT_EXPIRES_IN', DEFAULT_JWT_EXPIRES_IN)
    .trim();
  if (!EXPIRES_IN_PATTERN.test(value)) {
    throw new Error(
      'JWT_EXPIRES_IN debe ser un número de segundos o una duración como 15m, 1h o 7d',
    );
  }
  return /^\d+$/.test(value)
    ? Number(value)
    : (value as Exclude<JwtSignOptions['expiresIn'], number | undefined>);
}
