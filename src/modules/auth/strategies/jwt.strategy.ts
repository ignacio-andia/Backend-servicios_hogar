import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserStatus } from '../../../generated/prisma/enums.js';
import { PublicUser, UsersService } from '../../users/users.service.js';
import { getJwtSecret, JWT_ALGORITHM } from '../jwt.config.js';

export interface JwtPayload {
  sub: string;
  email: string;
}

const INVALID_SESSION_MESSAGE = 'Sesión inválida';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(config),
      algorithms: [JWT_ALGORITHM],
    });
  }

  /** La identidad, los roles y el estado se leen de la base de datos en cada petición. */
  async validate(payload: Partial<JwtPayload>): Promise<PublicUser> {
    if (typeof payload.sub !== 'string') {
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    }

    let user: PublicUser;
    try {
      user = await this.usersService.findById(payload.sub);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
      }
      throw error;
    }

    if (user.status !== UserStatus.ACTIVO) {
      throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
    }
    return user;
  }
}
