import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuthRateLimiter,
  TooManyAttemptsException,
} from './auth-rate-limiter.js';

const MINUTE = 60_000;

const limiter = (values: Record<string, string> = {}) =>
  new AuthRateLimiter(
    new ConfigService({
      AUTH_LOGIN_MAX_FAILURES: '3',
      AUTH_LOGIN_MAX_FAILURES_PER_IP: '5',
      AUTH_LOGIN_WINDOW_MINUTES: '15',
      AUTH_REGISTER_MAX_PER_IP: '2',
      AUTH_REGISTER_WINDOW_MINUTES: '60',
      ...values,
    }),
  );
const wrong = () => Promise.reject(new UnauthorizedException());
const right = () => Promise.resolve('ok');

describe('AuthRateLimiter', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  const fail = (target: AuthRateLimiter, times: number, email = 'a@x.test') =>
    Promise.all(
      Array.from({ length: times }, () =>
        expect(target.login('ip', email, wrong)).rejects.toBeInstanceOf(
          UnauthorizedException,
        ),
      ),
    );

  it('tras los fallos permitidos responde 429 sin comprobar la contrasena', async () => {
    const target = limiter();
    await fail(target, 3);
    const attempt = vi.fn(right);

    await expect(target.login('ip', 'a@x.test', attempt)).rejects.toMatchObject(
      { status: 429, retryAfterSeconds: 900 },
    );
    // El mismo correo escrito de otra forma no evita el limite.
    await expect(
      target.login('ip', '  A@X.test ', attempt),
    ).rejects.toBeInstanceOf(TooManyAttemptsException);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('no afecta a otra direccion IP y termina con la ventana', async () => {
    const target = limiter();
    await fail(target, 3);

    await expect(target.login('otra-ip', 'a@x.test', right)).resolves.toBe(
      'ok',
    );
    vi.advanceTimersByTime(15 * MINUTE);
    await expect(target.login('ip', 'a@x.test', right)).resolves.toBe('ok');
  });

  it('un acceso correcto borra los fallos de ese correo', async () => {
    const target = limiter();
    await fail(target, 2);
    await target.login('ip', 'a@x.test', right);

    await fail(target, 3);
  });

  it('limita por IP aunque se cambie de correo', async () => {
    const target = limiter();
    for (let i = 0; i < 5; i += 1) {
      await fail(target, 1, `u${i}@x.test`);
    }

    await expect(
      target.login('ip', 'nuevo@x.test', right),
    ).rejects.toBeInstanceOf(TooManyAttemptsException);
  });

  it('los accesos correctos y los errores que no son 401 no cuentan', async () => {
    const target = limiter();
    for (let i = 0; i < 10; i += 1) {
      await target.login('ip', 'a@x.test', right);
      await expect(
        target.login('ip', 'b@x.test', () =>
          Promise.reject(new ForbiddenException()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('las peticiones simultaneas no superan el limite', async () => {
    const target = limiter();
    const attempt = vi.fn(wrong);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => target.login('ip', 'a@x.test', attempt)),
    );

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(10);
  });

  it('limita los registros por IP, con exito o sin el', async () => {
    const target = limiter();
    await target.register('ip', right);
    await expect(target.register('ip', wrong)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    await expect(target.register('ip', right)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 3600,
    });
    await expect(target.register('otra-ip', right)).resolves.toBe('ok');
  });

  it('un valor de configuracion invalido detiene el arranque', () => {
    expect(() => limiter({ AUTH_LOGIN_MAX_FAILURES: '0' })).toThrow(
      /AUTH_LOGIN_MAX_FAILURES/,
    );
  });
});
