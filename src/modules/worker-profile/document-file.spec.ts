import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  detectMimeType,
  documentMaxBytes,
  sanitizeFileName,
  validateDocumentFile,
} from './document-file.js';

const PDF = Buffer.from('%PDF-1.7\n%prueba\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

const file = (
  buffer: Buffer,
  originalname = 'doc.pdf',
  mimetype = 'application/pdf',
) => ({
  buffer,
  size: buffer.length,
  originalname,
  mimetype,
});

describe('document-file', () => {
  it('detecta el formato por la firma del contenido', () => {
    expect(detectMimeType(PDF)).toBe('application/pdf');
    expect(detectMimeType(PNG)).toBe('image/png');
    expect(detectMimeType(JPG)).toBe('image/jpeg');
    expect(detectMimeType(Buffer.from('hola'))).toBeNull();
  });

  it('ignora la extension y el Content-Type declarados por el cliente', () => {
    expect(() =>
      validateDocumentFile(
        file(Buffer.from('MZ ejecutable'), 'cedula.pdf', 'application/pdf'),
        1024,
      ),
    ).toThrow('Formato de archivo no permitido');

    const validated = validateDocumentFile(
      file(PNG, 'foto.pdf', 'text/plain'),
      1024,
    );
    expect(validated.mimeType).toBe('image/png');
  });

  it('rechaza archivos vacios, ausentes o demasiado grandes', () => {
    expect(() => validateDocumentFile(undefined, 1024)).toThrow(
      BadRequestException,
    );
    expect(() => validateDocumentFile(file(Buffer.alloc(0)), 1024)).toThrow(
      BadRequestException,
    );
    expect(() => validateDocumentFile(file(PDF), PDF.length - 1)).toThrow(
      'El archivo supera el tamaño máximo permitido',
    );
  });

  it('calcula el hash y limpia el nombre original', () => {
    const validated = validateDocumentFile(
      file(PDF, '..\\..\\etc/"cedula"<1>.pdf'),
      1024,
    );

    expect(validated.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validated.originalName).toBe('cedula1.pdf');
  });

  it('usa un nombre por defecto si el original queda vacio', () => {
    expect(sanitizeFileName('../')).toBe('documento');
    expect(sanitizeFileName(undefined)).toBe('documento');
  });

  it('lee el limite de WORKER_DOCUMENT_MAX_MB y valida su rango', () => {
    expect(documentMaxBytes(new ConfigService({}))).toBe(5 * 1024 * 1024);
    expect(
      documentMaxBytes(new ConfigService({ WORKER_DOCUMENT_MAX_MB: '2' })),
    ).toBe(2 * 1024 * 1024);
    expect(() =>
      documentMaxBytes(new ConfigService({ WORKER_DOCUMENT_MAX_MB: '500' })),
    ).toThrow(/WORKER_DOCUMENT_MAX_MB/);
  });
});
