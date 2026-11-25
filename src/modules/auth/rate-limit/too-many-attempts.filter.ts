import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { TooManyAttemptsException } from './auth-rate-limiter.js';

/** 429 con la cabecera Retry-After (segundos hasta el proximo intento). */
@Catch(TooManyAttemptsException)
export class TooManyAttemptsFilter implements ExceptionFilter {
  catch(exception: TooManyAttemptsException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(exception.retryAfterSeconds))
      .status(exception.getStatus())
      .json(exception.getResponse());
  }
}
