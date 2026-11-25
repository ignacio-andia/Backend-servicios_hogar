import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  RoleName,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountStatusRegistry } from './account-status.registry.js';
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
// Clave del bloqueo advisory que serializa la creacion del primer administrador.
const FIRST_ADMIN_LOCK = 'arreglaloya:first-administrator';
export const FIRST_ADMIN_EXISTS_MESSAGE =
  'Ya existe un administrador: este procedimiento solo crea el primero.';
const PRISMA_RECORD_NOT_FOUND = 'P2025';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accountStatus: AccountStatusRegistry,
    private readonly audit: AuditService,
  ) {}

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

  /**
   * Inicializacion del sistema (RF-04): crea la primera cuenta con rol
   * ADMINISTRADOR. Solo la usa el comando interno de inicializacion; no hay
   * endpoint. Falla si ya existe cualquier cuenta con ese rol (en cualquier
   * estado), asi que no sirve para crear administradores adicionales.
   *
   * Un bloqueo advisory de PostgreSQL serializa ejecuciones simultaneas: la
   * comprobacion y la creacion ocurren en la misma transaccion, de modo que
   * dos ejecuciones a la vez no pueden crear dos administradores.
   */
  async createFirstAdministrator(dto: CreateUserDto): Promise<PublicUser> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK}))`;
        const administrators = await tx.userRole.count({
          where: { role: RoleName.ADMINISTRADOR },
        });
        if (administrators > 0) {
          throw new ConflictException(FIRST_ADMIN_EXISTS_MESSAGE);
        }
        const user = await tx.user.create({
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: normalizeEmail(dto.email),
            passwordHash: dto.passwordHash,
            phone: dto.phone ?? null,
            roles: { create: { role: RoleName.ADMINISTRADOR } },
          },
          select: PUBLIC_USER_SELECT,
        });
        return toPublicUser(user);
      });
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

  /**
   * Otorga el rol TRABAJADOR cuando la propia cuenta registra su perfil de
   * trabajador (decision del equipo). Es una operacion del sistema, no una
   * eleccion libre de roles: solo puede asignar TRABAJADOR, nunca un rol
   * privilegiado, y no implica aprobacion (eso lo decide el perfil, RF-03).
   * Recibe la transaccion del llamador para que el rol y el perfil se creen
   * juntos o no se cree ninguno. Es idempotente.
   */
  async grantWorkerRole(
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.userRole.upsert({
      where: { userId_role: { userId, role: RoleName.TRABAJADOR } },
      create: { userId, role: RoleName.TRABAJADOR },
      update: {},
    });
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

    // Suspender una cuenta tiene efectos en otros modulos (por ejemplo,
    // cancelar su solicitud de cambio de zona pendiente, T4-F3). Van en la
    // misma transaccion que el cambio de estado: si alguno falla, la cuenta
    // no queda suspendida. Solo un administrador puede suspender (arriba).
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id },
        data: { status },
        select: PUBLIC_USER_SELECT,
      });
      if (status === UserStatus.SUSPENDIDO) {
        await this.accountStatus.runSuspended(tx, {
          userId: id,
          actorId: actor.id,
        });
      }
      // RF-53: la bitacora recoge las acciones de un administrador (no la baja
      // que un usuario hace de su propia cuenta). En la misma transaccion.
      if (isAdmin(actor)) {
        await this.audit.record(
          {
            actorId: actor.id,
            action: AuditAction.CAMBIO_ESTADO,
            entityType: AuditEntityType.USUARIO,
            entityId: id,
            details: { fromStatus: user.status, toStatus: status },
          },
          tx,
        );
      }
      return row;
    });
    return toPublicUser(updated);
  }

  /**
   * Para otros modulos: dentro de la transaccion `tx` del llamador bloquea la
   * cuenta con FOR SHARE y la devuelve. Hasta que esa transaccion termine nadie
   * puede cambiar su estado ni su telefono: una suspension o una edicion
   * simultanea espera, o ya se ve aplicada si se confirmo antes.
   *
   * Orden de bloqueos del proyecto: la cuenta va primero, antes que el
   * trabajador, el pedido y los catalogos.
   */
  async findByIdForShare(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<PublicUser> {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id}::uuid FOR SHARE`;
    const user = await tx.user.findUnique({
      where: { id },
      select: PUBLIC_USER_SELECT,
    });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return toPublicUser(user);
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
