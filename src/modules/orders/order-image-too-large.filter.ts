import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrderImageProcessor } from './images/order-image.processor.js';

/**
 * Multer corta la subida al superar el peso configurado y responde en
 * ingles; este filtro devuelve el mismo 413 con un mensaje claro.
 */
@Injectable()
@Catch(PayloadTooLargeException)
export class OrderImageTooLargeFilter implements ExceptionFilter {
  constructor(private readonly processor: OrderImageProcessor) {}

  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.PAYLOAD_TOO_LARGE)
      .json({
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        error: 'Payload Too Large',
        message: this.processor.tooLargeMessage(),
      });
  }
}
