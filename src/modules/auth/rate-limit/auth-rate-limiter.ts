import { createHash } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readPositiveInt } from '../../../common/config-values.js';

export const TOO_MANY_LOGINS_MESSAGE =
  'Demasiados intentos de inicio de sesión. Espere unos minutos antes de volver a intentarlo.';
export const TOO_MANY_REGISTRATIONS_MESSAGE =
  'Demasiados registros desde su conexión. Espere antes de volver a intentarlo.';

/** Tope de claves en memoria: al superarlo se descartan las mas antiguas. */
export const MAX_TRACKED_KEYS = 10_000;

export class TooManyAttemptsException extends HttpException {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message,
        error: 'Too Many Requests',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

interface Window {
  count: number;
  resetsAt: number;
}

interface Limit {
  key: string;
  max: number;
  windowMs: number;
}

/**
 * Limite de intentos de autenticacion, con ventanas fijas en memoria.
 * - Login: fallos (401) por correo y direccion IP, y por IP en total. Un acceso
 *   correcto borra los fallos de ese correo.
 * - Registro: intentos por IP.
 * El intento se cuenta ANTES de ejecutarlo, asi que las peticiones simultaneas
 * no superan el limite. El contador es de cada instancia y se pierde al
 * reiniciar: con varias instancias hace falta un almacen compartido.
 */
@Injectable()
export class AuthRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly loginMax: number;
  private readonly loginMaxPerIp: number;
  private readonly loginWindowMs: number;
  private readonly registerMax: number;
  private readonly registerWindowMs: number;

  constructor(config: ConfigService) {
    const read = (key: string, fallback: number) =>
      readPositiveInt(config, key, fallback, { max: 100_000 });
    this.loginMax = read('AUTH_LOGIN_MAX_FAILURES', 5);
    this.loginMaxPerIp = read('AUTH_LOGIN_MAX_FAILURES_PER_IP', 30);
    this.loginWindowMs = read('AUTH_LOGIN_WINDOW_MINUTES', 15) * 60_000;
    this.registerMax = read('AUTH_REGISTER_MAX_PER_IP', 20);
    this.registerWindowMs = read('AUTH_REGISTER_WINDOW_MINUTES', 60) * 60_000;
  }

  async login<T>(
    ip: string,
    email: string,
    attempt: () => Promise<T>,
  ): Promise<T> {
    // El correo no se guarda en claro como clave.
    const account = createHash('sha256')
      .update(email.trim().toLowerCase())
      .digest('hex');
    const byAccount = `login:${ip}:${account}`;
    const byIp = `login-ip:${ip}`;
    const windowMs = this.loginWindowMs;
    this.reserve(
      [
        { key: byAccount, max: this.loginMax, windowMs },
        { key: byIp, max: this.loginMaxPerIp, windowMs },
      ],
      TOO_MANY_LOGINS_MESSAGE,
    );
    try {
      const result = await attempt();
      this.windows.delete(byAccount);
      this.release(byIp);
      return result;
    } catch (error) {
      // Solo cuentan las credenciales incorrectas: ni la cuenta inactiva
      // (contrasena correcta) ni un fallo del servidor.
      if (!(error instanceof UnauthorizedException)) {
        this.release(byAccount);
        this.release(byIp);
      }
      throw error;
    }
  }

  async register<T>(ip: string, attempt: () => Promise<T>): Promise<T> {
    this.reserve(
      [
        {
          key: `register:${ip}`,
          max: this.registerMax,
          windowMs: this.registerWindowMs,
        },
      ],
      TOO_MANY_REGISTRATIONS_MESSAGE,
    );
    return attempt();
  }

  /** Cuenta un intento en cada limite, o lanza 429 sin contar ninguno. */
  private reserve(limits: Limit[], message: string): void {
    const now = Date.now();
    for (const { key, max } of limits) {
      const window = this.windows.get(key);
      if (window && window.resetsAt > now && window.count >= max) {
        throw new TooManyAttemptsException(
          message,
          Math.ceil((window.resetsAt - now) / 1000),
        );
      }
    }
    for (const { key, windowMs } of limits) {
      const window = this.windows.get(key);
      if (window && window.resetsAt > now) {
        window.count += 1;
      } else {
        this.windows.delete(key);
        this.makeRoom(now);
        this.windows.set(key, { count: 1, resetsAt: now + windowMs });
      }
    }
  }

  private release(key: string): void {
    const window = this.windows.get(key);
    if (window && --window.count <= 0) {
      this.windows.delete(key);
    }
  }

  private makeRoom(now: number): void {
    if (this.windows.size < MAX_TRACKED_KEYS) {
      return;
    }
    for (const [key, window] of this.windows) {
      if (window.resetsAt <= now) {
        this.windows.delete(key);
      }
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size < MAX_TRACKED_KEYS) {
        return;
      }
      this.windows.delete(key);
    }
  }
}
