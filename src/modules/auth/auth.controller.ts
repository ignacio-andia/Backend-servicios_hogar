import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { PublicUser } from '../users/users.service.js';
import { AuthResponse, AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { AuthRateLimiter } from './rate-limit/auth-rate-limiter.js';
import { TooManyAttemptsFilter } from './rate-limit/too-many-attempts.filter.js';

// Registro y login limitan los intentos abusivos (429 con Retry-After).
@Controller('auth')
@UseFilters(TooManyAttemptsFilter)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly limiter: AuthRateLimiter,
  ) {}

  @Post('register')
  register(@Body() dto: RegisterDto, @Ip() ip: string): Promise<AuthResponse> {
    return this.limiter.register(ip, () => this.authService.register(dto));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Ip() ip: string): Promise<AuthResponse> {
    return this.limiter.login(ip, dto.email, () => this.authService.login(dto));
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: PublicUser): PublicUser {
    return user;
  }
}
