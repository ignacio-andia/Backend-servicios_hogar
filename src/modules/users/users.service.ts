import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Prisma, RoleName, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { ListUsersQueryDto } from './dto/list-users-query.dto.js';
import { UpdateUserStatusDto } from './dto/update-user-status.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';

const PUBLIC_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  roles: { select: { role: true }, orderBy: { role: 'asc' } },
} satisfies Prisma.UserSelect;

type PublicUserRecord = Prisma.UserGetPayload<{
  select: typeof PUBLIC_USER_SELECT;
}>;

export interface PublicUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  roles: RoleName[];
  createdAt: Date;
  updatedAt: Date;
}

/** Solo para AuthModule: incluye el hash y nunca debe devolverse por HTTP. */
export interface UserCredentials {
  id: string;
  email: string;
  passwordHash: string;
  status: UserStatus;
  roles: RoleName[];
}

export interface PaginatedUsers {
  data: PublicUser[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface Actor {
  id: string;
  roles: RoleName[];
}

const PRISMA_UNIQUE_VIOLATION = 'P2002';
const PRISMA_RECORD_NOT_FOUND = 'P2025';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Crea la cuenta con el rol inicial CLIENTE. Lo invoca AuthModule en el registro. */
  async create(dto: CreateUserDto): Promise<PublicUser> {
    try {
      const user = await this.prisma.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: normalizeEmail(dto.email),
          passwordHash: dto.passwordHash,
          phone: dto.phone ?? null,
          roles: { create: { role: RoleName.CLIENTE } },
        },
        select: PUBLIC_USER_SELECT,
      });
      return toPublicUser(user);
    } catch (error) {
      if (isPrismaError(error, PRISMA_UNIQUE_VIOLATION)) {
        throw new ConflictException('El correo electrónico ya está registrado');
      }
      throw error;
    }
  }

  async findById(id: string): Promise<PublicUser> {
    const user = isUUID(id)
      ? await this.prisma.user.findUnique({
          where: { id },
          select: PUBLIC_USER_SELECT,
        })
      : null;

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return toPublicUser(user);
  }

  async findByEmail(email: string): Promise<PublicUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: PUBLIC_USER_SELECT,
    });
    return user ? toPublicUser(user) : null;
  }

  async findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        roles: { select: { role: true } },
      },
    });
    return user ? { ...user, roles: user.roles.map(({ role }) => role) } : null;
  }

  async getRoles(userId: string): Promise<RoleName[]> {
    return (await this.findById(userId)).roles;
  }

  /** Restringido a administradores; nadie puede modificar sus propios roles. */
  async assignRole(
    actorId: string,
    userId: string,
    role: RoleName,
  ): Promise<PublicUser> {
    const actor = await this.getActor(actorId);
    assertCanManageRoles(actor, userId);
    await this.findById(userId);

    await this.prisma.userRole.upsert({
      where: { userId_role: { userId, role } },
      create: { userId, role, assignedById: actor.id },
      update: {},
    });
    return this.findById(userId);
  }

  async revokeRole(
    actorId: string,
    userId: string,
    role: RoleName,
  ): Promise<PublicUser> {
    const actor = await this.getActor(actorId);
    assertCanManageRoles(actor, userId);
    const user = await this.findById(userId);

    if (!user.roles.includes(role)) {
      return user;
    }
    if (user.roles.length === 1) {
      throw new BadRequestException(
        'El usuario debe conservar al menos un rol',
      );
    }

    await this.prisma.userRole.delete({
      where: { userId_role: { userId, role } },
    });
    return this.findById(userId);
  }

  async findAll(
    actorId: string,
    { page, limit }: ListUsersQueryDto,
  ): Promise<PaginatedUsers> {
    assertAdmin(await this.getActor(actorId));

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count(),
    ]);

    return {
      data: users.map(toPublicUser),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(actorId: string, id: string): Promise<PublicUser> {
    assertSelfOrAdmin(await this.getActor(actorId), id);
    return this.findById(id);
  }

  async update(
    actorId: string,
    id: string,
    dto: UpdateUserDto,
  ): Promise<PublicUser> {
    assertSelfOrAdmin(await this.getActor(actorId), id);

    const data: Prisma.UserUpdateInput = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.phone !== undefined) data.phone = dto.phone;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'Debe enviar al menos un dato a actualizar',
      );
    }

    try {
      const user = await this.prisma.user.update({
        where: { id },
        data,
        select: PUBLIC_USER_SELECT,
      });
      return toPublicUser(user);
    } catch (error) {
      if (isPrismaError(error, PRISMA_RECORD_NOT_FOUND)) {
        throw new NotFoundException('Usuario no encontrado');
      }
      throw error;
    }
  }

  /**
   * Un usuario solo puede desactivar su propia cuenta; los administradores
   * pueden asignar cualquier estado, sin dejar la plataforma sin
   * administradores activos.
   */
  async updateStatus(
    actorId: string,
    id: string,
    { status }: UpdateUserStatusDto,
  ): Promise<PublicUser> {
    const actor = await this.getActor(actorId);

    if (!isAdmin(actor)) {
      if (actor.id !== id) {
        throw new ForbiddenException(
          'No tiene permisos para modificar este usuario',
        );
      }
      if (status !== UserStatus.INACTIVO) {
        throw new ForbiddenException('Solo puede desactivar su propia cuenta');
      }
    }

    const user = await this.findById(id);
    if (user.status === status) {
      return user;
    }

    const losesActiveAdmin =
      user.status === UserStatus.ACTIVO &&
      user.roles.includes(RoleName.ADMINISTRADOR);
    if (losesActiveAdmin && (await this.countActiveAdmins()) <= 1) {
      throw new ConflictException(
        'No se puede desactivar al único administrador activo',
      );
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status },
      select: PUBLIC_USER_SELECT,
    });
    return toPublicUser(updated);
  }

  /** Roles y estado del actor se leen de la base de datos, no de la petición. */
  private async getActor(actorId: string): Promise<Actor> {
    const actor = isUUID(actorId)
      ? await this.prisma.user.findUnique({
          where: { id: actorId },
          select: { id: true, status: true, roles: { select: { role: true } } },
        })
      : null;

    if (!actor || actor.status !== UserStatus.ACTIVO) {
      throw new UnauthorizedException(
        'La sesión no corresponde a una cuenta activa',
      );
    }
    return { id: actor.id, roles: actor.roles.map(({ role }) => role) };
  }

  private countActiveAdmins(): Promise<number> {
    return this.prisma.user.count({
      where: {
        status: UserStatus.ACTIVO,
        roles: { some: { role: RoleName.ADMINISTRADOR } },
      },
    });
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toPublicUser({ roles, ...user }: PublicUserRecord): PublicUser {
  return { ...user, roles: roles.map(({ role }) => role) };
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}

function isAdmin(actor: Actor): boolean {
  return actor.roles.includes(RoleName.ADMINISTRADOR);
}

function assertAdmin(actor: Actor): void {
  if (!isAdmin(actor)) {
    throw new ForbiddenException('Operación reservada a administradores');
  }
}

function assertSelfOrAdmin(actor: Actor, userId: string): void {
  if (actor.id !== userId && !isAdmin(actor)) {
    throw new ForbiddenException(
      'No tiene permisos para acceder a este usuario',
    );
  }
}

function assertCanManageRoles(actor: Actor, userId: string): void {
  assertAdmin(actor);
  if (actor.id === userId) {
    throw new ForbiddenException('No puede modificar sus propios roles');
  }
}
