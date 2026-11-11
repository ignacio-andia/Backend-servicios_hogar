import { IsEnum } from 'class-validator';
import { WorkerDocumentType } from '../../../generated/prisma/enums.js';

/** Campo de texto que acompana al archivo (multipart/form-data). */
export class UploadDocumentDto {
  @IsEnum(WorkerDocumentType)
  type: WorkerDocumentType;
}
