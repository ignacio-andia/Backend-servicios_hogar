import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOfferDto } from './create-offer.dto.js';

// Mismas opciones que el ValidationPipe global (setupApp).
const errorsOf = async (body: object) =>
  (
    await validate(plainToInstance(CreateOfferDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((error) => error.property);

const body = (proposedStartAt: unknown) => ({
  amount: '120.50',
  requiresVisit: false,
  materialsIncluded: true,
  proposedStartAt,
  estimatedDurationMinutes: 60,
});

describe('CreateOfferDto.proposedStartAt (G1)', () => {
  it.each([
    '2026-11-30T10:00:00-04:00',
    '2026-11-30T14:00:00Z',
    '2026-11-30T14:00:00.000Z',
    '2026-11-30T10:00-04:00',
    '2026-11-30T15:00:00+01:00',
  ])('acepta una fecha con zona horaria explicita (%s)', async (value) => {
    expect(await errorsOf(body(value))).toEqual([]);
  });

  it.each([
    '2026-11-30T10:00:00',
    '2026-11-30T10:00',
    '2026-11-30',
    '2026-11-30 10:00:00-04:00',
    '2026-11-30T10:00:00-0400',
    '2026-11-30T10:00:00+4',
    '2026-02-30T10:00:00Z',
    'manana a las 10',
  ])('rechaza una fecha sin zona horaria o mal formada (%s)', async (value) => {
    expect(await errorsOf(body(value))).toEqual(['proposedStartAt']);
  });

  it('el mensaje indica el formato esperado', async () => {
    const [error] = await validate(
      plainToInstance(CreateOfferDto, body('2026-11-30T10:00:00')),
    );
    expect(Object.values(error.constraints ?? {})).toContain(
      'proposedStartAt debe incluir fecha, hora y zona horaria, por ejemplo 2026-11-30T10:00:00-04:00 o 2026-11-30T14:00:00Z',
    );
  });
});
