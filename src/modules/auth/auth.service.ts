import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { UserStatus } from '../../generated/prisma/enums.js';
import { PublicUser, UsersService } from '../users/users.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import type { JwtPayload } from './strategies/jwt.strategy.js';

export const BCRYPT_SALT_ROUNDS = 12;
const INVALID_CREDENTIALS_MESSAGE = 'Credenciales inválidas';

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  user: PublicUser;
}

@Injectable()
export class AuthService {
  /** Hash de relleno para que un correo inexistente tarde lo mismo que uno válido. */
  private readonly dummyHash = bcrypt.hash(randomUUID(), BCRYPT_SALT_ROUNDS);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const user = await this.usersService.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS),
    });
    return this.buildResponse(user);
  }

  /**
   * La contraseña se verifica antes que el estado de la cuenta para no
   * revelar a terceros si un correo existe o está desactivado.
   */
  async login({ email, password }: LoginDto): Promise<AuthResponse> {
    const credentials = await this.usersService.findCredentialsByEmail(email);
    const passwordMatches = await bcrypt.compare(
      password,
      credentials?.passwordHash ?? (await this.dummyHash),
    );

    if (!credentials || !passwordMatches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }
    if (credentials.status !== UserStatus.ACTIVO) {
      throw new ForbiddenException('La cuenta no está activa');
    }

    return this.buildResponse(await this.usersService.findById(credentials.id));
  }

  private async buildResponse(user: PublicUser): Promise<AuthResponse> {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    return {
      accessToken: await this.jwtService.signAsync(payload),
      tokenType: 'Bearer',
      user,
    };
  }
}
