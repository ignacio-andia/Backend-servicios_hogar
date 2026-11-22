import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BCRYPT_SALT_ROUNDS } from '../modules/auth/auth.service.js';
import { RegisterDto } from '../modules/auth/dto/register.dto.js';
import { PublicUser, UsersService } from '../modules/users/users.service.js';

/** Datos que pide el comando de inicializacion. La contrasena llega en claro. */
export interface FirstAdminInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
}

/** Datos invalidos: lleva todos los mensajes para mostrarlos juntos. */
export class FirstAdminInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'FirstAdminInputError';
  }
}

/**
 * Crea el primer administrador (RF-04). Valida los datos con las mismas
 * reglas que el registro publico (RegisterDto: nombre, correo, contrasena y
 * telefono), hashea la contrasena con el mismo bcrypt y las mismas rondas que
 * AuthService, y delega la creacion atomica en UsersService.
 */
@Injectable()
export class FirstAdministratorService {
  constructor(private readonly users: UsersService) {}

  async create(input: FirstAdminInput): Promise<PublicUser> {
    const dto = plainToInstance(RegisterDto, { ...input });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      throw new FirstAdminInputError(
        errors.flatMap((error) => Object.values(error.constraints ?? {})),
      );
    }
    return this.users.createFirstAdministrator({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS),
    });
  }
}
