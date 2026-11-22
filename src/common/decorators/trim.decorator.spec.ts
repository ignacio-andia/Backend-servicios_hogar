import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RegisterDto } from '../../modules/auth/dto/register.dto.js';
import { UpdateUserDto } from '../../modules/users/dto/update-user.dto.js';

// Misma configuracion que el ValidationPipe global (setup-app.ts).
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = <T>(metatype: new () => T, body: object): Promise<T> =>
  pipe.transform(body, { type: 'body', metatype }) as Promise<T>;
const messagesOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  const response = (error as BadRequestException).getResponse() as {
    message: string[];
  };
  return response.message;
};

const register = (extra: object = {}) => ({
  firstName: 'Ana',
  lastName: 'Pérez',
  email: 'ana@example.com',
  password: 'Clave1234',
  ...extra,
});

describe('TrimEmptyAs en los DTOs de cuentas', () => {
  describe('RegisterDto.phone (vacio = ausente)', () => {
    it.each([
      ['cadena vacia', ''],
      ['solo espacios', '   '],
    ])('trata %s como ausente', async (_label, phone) => {
      const dto = await validate(RegisterDto, register({ phone }));
      expect(dto.phone).toBeUndefined();
    });

    it('acepta un telefono valido recortando espacios', async () => {
      const dto = await validate(
        RegisterDto,
        register({ phone: ' 70000000 ' }),
      );
      expect(dto.phone).toBe('70000000');
    });

    it('acepta omitir el telefono', async () => {
      const dto = await validate(RegisterDto, register());
      expect(dto.phone).toBeUndefined();
    });

    it('sigue rechazando telefonos invalidos', async () => {
      expect(
        await messagesOf(
          validate(RegisterDto, register({ phone: '7000-0000' })),
        ),
      ).toEqual([expect.stringContaining('phone debe tener')]);
    });

    it('rechaza confirmPassword y cualquier propiedad extra', async () => {
      expect(
        await messagesOf(
          validate(RegisterDto, register({ confirmPassword: 'Clave1234' })),
        ),
      ).toEqual(['property confirmPassword should not exist']);
    });
  });

  describe('UpdateUserDto.phone (vacio = borrar)', () => {
    it.each([
      ['cadena vacia', ''],
      ['solo espacios', '   '],
      ['null', null],
    ])('convierte %s en null', async (_label, phone) => {
      const dto = await validate(UpdateUserDto, { phone });
      expect(dto.phone).toBeNull();
    });

    it('mantiene un telefono valido', async () => {
      const dto = await validate(UpdateUserDto, { phone: ' +59171234567 ' });
      expect(dto.phone).toBe('+59171234567');
    });

    it('no toca el telefono si no se envia', async () => {
      const dto = await validate(UpdateUserDto, { lastName: 'Nuevo' });
      expect(dto.phone).toBeUndefined();
    });

    it('sigue rechazando telefonos invalidos', async () => {
      expect(
        await messagesOf(validate(UpdateUserDto, { phone: 'abc' })),
      ).toEqual([expect.stringContaining('phone debe tener')]);
    });
  });
});
