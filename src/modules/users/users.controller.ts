import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ListUsersQueryDto } from './dto/list-users-query.dto.js';
import { UpdateUserStatusDto } from './dto/update-user-status.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import type { PaginatedUsers, PublicUser } from './users.service.js';
import { UsersService } from './users.service.js';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll(
    @CurrentUser() actor: PublicUser,
    @Query() query: ListUsersQueryDto,
  ): Promise<PaginatedUsers> {
    return this.usersService.findAll(actor.id, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PublicUser> {
    return this.usersService.findOne(actor.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<PublicUser> {
    return this.usersService.update(actor.id, id, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() actor: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
  ): Promise<PublicUser> {
    return this.usersService.updateStatus(actor.id, id, dto);
  }
}
