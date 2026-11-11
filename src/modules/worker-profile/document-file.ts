import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const DEFAULT_DOCUMENT_MAX_MB = 5;
export const ABSOLUTE_DOCUMENT_MAX_MB = 20;

/** Archivo recibido por multer en memoria (solo los campos que se usan). */
export interface UploadedDocumentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ValidatedDocumentFile {
  content: Buffer;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  originalName: string;
}

// El tipo se decide por la firma del contenido, no por la extension ni por
// el Content-Type que envia el cliente, que pueden falsificarse.
const SIGNATURES: { mimeType: string; label: string; magic: number[] }[] = [
  {
    mimeType: 'application/pdf',
    label: 'PDF',
    magic: [0x25, 0x50, 0x44, 0x46, 0x2d],
  },
  { mimeType: 'image/jpeg', label: 'JPG', magic: [0xff, 0xd8, 0xff] },
  {
    mimeType: 'image/png',
    label: 'PNG',
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
];

export const ALLOWED_DOCUMENT_FORMATS = SIGNATURES.map((s) => s.label).join(
  ', ',
);

export function documentMaxBytes(config: ConfigService): number {
  const value = Number(
    config.get<string>(
      'WORKER_DOCUMENT_MAX_MB',
      String(DEFAULT_DOCUMENT_MAX_MB),
    ),
  );
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > ABSOLUTE_DOCUMENT_MAX_MB
  ) {
    throw new Error(
      `WORKER_DOCUMENT_MAX_MB debe ser un numero entre 0 y ${ABSOLUTE_DOCUMENT_MAX_MB}`,
    );
  }
  return Math.floor(value * 1024 * 1024);
}

export function formatMegabytes(bytes: number): string {
  return `${Number((bytes / (1024 * 1024)).toFixed(2))} MB`;
}

export function detectMimeType(content: Buffer): string | null {
  const match = SIGNATURES.find(
    ({ magic }) =>
      content.length >= magic.length &&
      magic.every((byte, index) => content[index] === byte),
  );
  return match?.mimeType ?? null;
}

/** Valida formato y tamano; devuelve los datos que se guardan. */
export function validateDocumentFile(
  file: UploadedDocumentFile | undefined,
  maxBytes: number,
): ValidatedDocumentFile {
  if (!file?.buffer || file.size === 0) {
    throw new BadRequestException(
      'Debe adjuntar un archivo no vacío en el campo "file"',
    );
  }
  if (file.size > maxBytes) {
    throw new BadRequestException(
      `El archivo supera el tamaño máximo permitido de ${formatMegabytes(maxBytes)}`,
    );
  }
  const mimeType = detectMimeType(file.buffer);
  if (!mimeType) {
    throw new BadRequestException(
      `Formato de archivo no permitido. Formatos aceptados: ${ALLOWED_DOCUMENT_FORMATS}`,
    );
  }
  return {
    content: file.buffer,
    mimeType,
    sizeBytes: file.size,
    sha256: createHash('sha256').update(file.buffer).digest('hex'),
    originalName: sanitizeFileName(file.originalname),
  };
}

/** Nombre seguro para mostrar y para Content-Disposition (sin rutas ni controles). */
export function sanitizeFileName(name: string | undefined): string {
  const base = path
    .basename((name ?? '').replace(/\\/g, '/'))
    .replace(/[\p{Cc}"<>|*?:]/gu, '')
    .trim()
    .replace(/^\.+/, '');
  return (base || 'documento').slice(0, 255);
}
