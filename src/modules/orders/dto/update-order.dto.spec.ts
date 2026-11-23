import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOrderDto } from './update-order.dto.js';

// Mismas opciones que el ValidationPipe global (setupApp).
const errorsOf = async (body: object) =>
  (
    await validate(plainToInstance(UpdateOrderDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((error) => error.property);

const CATEGORY = '33333333-3333-4333-8333-333333333333';

describe('UpdateOrderDto (T5.2)', () => {
  it('acepta cambiar la categoria con un UUID', async () => {
    expect(await errorsOf({ categoryId: CATEGORY })).toEqual([]);
  });

  it.each([['no-es-uuid'], [''], [null], [123]])(
    'rechaza una categoria invalida (%j)',
    async (categoryId) => {
      expect(await errorsOf({ categoryId })).toEqual(['categoryId']);
    },
  );

  it.each([
    'zoneId',
    'status',
    'clientId',
    'id',
    'publishedAt',
    'expiresAt',
    'revision',
    'assignedWorkerId',
    'lastEditedAt',
    'cancelledAt',
    'createdAt',
    'updatedAt',
  ])('no admite %s: no es un dato editable', async (property) => {
    expect(await errorsOf({ [property]: 'x' })).toEqual([property]);
  });
});
