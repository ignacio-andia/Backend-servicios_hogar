import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { formatMegabytes } from './document-file.js';
import { WorkerDocumentsService } from './worker-documents.service.js';

/**
 * Multer corta la subida al superar el limite y responde en ingles; este
 * filtro devuelve el mismo 413 con un mensaje claro (RF-07, flujo A1).
 */
@Injectable()
@Catch(PayloadTooLargeException)
export class DocumentTooLargeFilter implements ExceptionFilter {
  constructor(private readonly documents: WorkerDocumentsService) {}

  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.PAYLOAD_TOO_LARGE)
      .json({
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        error: 'Payload Too Large',
        message: `El archivo supera el tamaño máximo permitido de ${formatMegabytes(this.documents.maxSizeBytes)}`,
      });
  }
}
