import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { WorkerProfileStatus } from '../../../generated/prisma/enums.js';
import { ChangeWorkerProfileStatusDto } from './change-worker-profile-status.dto.js';

// Misma configuracion que el ValidationPipe global (setup-app.ts).
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (body: object) =>
  pipe.transform(body, {
    type: 'body',
    metatype: ChangeWorkerProfileStatusDto,
  }) as Promise<ChangeWorkerProfileStatusDto>;
const messagesOf = async (body: object): Promise<string[]> => {
  const error = await validate(body).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return ((error as BadRequestException).getResponse() as { message: string[] })
    .message;
};

describe('ChangeWorkerProfileStatusDto', () => {
  it.each([
    WorkerProfileStatus.OBSERVADO,
    WorkerProfileStatus.RECHAZADO,
    WorkerProfileStatus.SUSPENDIDO,
  ])('%s exige un motivo', async (status) => {
    expect(await messagesOf({ status })).toEqual(
      expect.arrayContaining([
        expect.stringContaining('reason es obligatorio'),
      ]),
    );
  });

  it.each([
    ['vacío', ''],
    ['solo espacios', '   '],
  ])('rechaza un motivo %s', async (_label, reason) => {
    expect(
      await messagesOf({ status: WorkerProfileStatus.RECHAZADO, reason }),
    ).toEqual([expect.stringContaining('reason es obligatorio')]);
  });

  it('recorta el motivo', async () => {
    const dto = await validate({
      status: WorkerProfileStatus.RECHAZADO,
      reason: '  Documento ilegible  ',
    });
    expect(dto.reason).toBe('Documento ilegible');
  });

  it('aprobar no exige motivo', async () => {
    const dto = await validate({ status: WorkerProfileStatus.APROBADO });
    expect(dto).toMatchObject({ status: WorkerProfileStatus.APROBADO });
    expect(dto.reason).toBeUndefined();
  });

  it.each([
    WorkerProfileStatus.PENDIENTE,
    WorkerProfileStatus.BORRADOR,
    'CUALQUIERA',
  ])('rechaza el estado %s', async (status) => {
    expect(await messagesOf({ status, reason: 'x' })).toEqual([
      expect.stringContaining('status debe ser uno de'),
    ]);
  });

  it('rechaza motivos de más de 1000 caracteres', async () => {
    await messagesOf({
      status: WorkerProfileStatus.OBSERVADO,
      reason: 'a'.repeat(1001),
    });
  });

  it('rechaza propiedades extra, como un id de administrador', async () => {
    expect(
      await messagesOf({
        status: WorkerProfileStatus.APROBADO,
        adminId: '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f',
      }),
    ).toEqual(['property adminId should not exist']);
  });
});
