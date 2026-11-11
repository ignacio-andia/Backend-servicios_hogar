import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto.js';
import { ListCatalogQueryDto } from './dto/list-catalog-query.dto.js';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto.js';

export const CatalogKind = {
  CATEGORY: 'CATEGORY',
  ZONE: 'ZONE',
} as const;
export type CatalogKind = (typeof CatalogKind)[keyof typeof CatalogKind];

/** Registro completo, para administración. */
export interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Opción pública para formularios: solo registros activos. */
export interface CatalogOption {
  id: string;
  name: string;
  description: string | null;
}

type Db = Prisma.TransactionClient;

/** Operaciones comunes a `serviceCategory` y `zone`, que tienen la misma forma. */
interface CatalogTable {
  findMany(args: {
    where: { isActive?: boolean; id?: { in: string[] } };
    orderBy: { name: 'asc' };
  }): Promise<CatalogItem[]>;
  findUnique(args: { where: { id: string } }): Promise<CatalogItem | null>;
  findFirst(args: {
    where: {
      name: { equals: string; mode: 'insensitive' };
      NOT?: { id: string };
    };
  }): Promise<CatalogItem | null>;
  create(args: {
    data: { name: string; description: string | null };
  }): Promise<CatalogItem>;
  update(args: {
    where: { id: string };
    data: { name?: string; description?: string | null; isActive?: boolean };
  }): Promise<CatalogItem>;
}

interface CatalogConfig {
  noun: string;
  entityType: AuditEntityType;
  table: (db: Db) => CatalogTable;
}

const CATALOGS: Record<CatalogKind, CatalogConfig> = {
  CATEGORY: {
    noun: 'categoría',
    entityType: AuditEntityType.CATEGORIA_SERVICIO,
    table: (db) => db.serviceCategory,
  },
  ZONE: {
    noun: 'zona',
    entityType: AuditEntityType.ZONA,
    table: (db) => db.zone,
  },
};

const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Catálogos de categorías de servicio (RF-48) y zonas de Cochabamba (RF-49).
 * Los registros nunca se borran: se desactivan, para conservar las
 * relaciones históricas. Cada cambio queda en la bitácora dentro de la
 * misma transacción.
 */
@Injectable()
export class CatalogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Opciones activas para formularios públicos, ordenadas por nombre. */
  async findActive(kind: CatalogKind): Promise<CatalogOption[]> {
    const items = await CATALOGS[kind]
      .table(this.prisma)
      .findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    return items.map(toOption);
  }

  async findActiveById(kind: CatalogKind, id: string): Promise<CatalogOption> {
    const item = await this.findItem(this.prisma, kind, id);
    if (!item?.isActive) {
      throw notFound(kind);
    }
    return toOption(item);
  }

  async findAll(
    kind: CatalogKind,
    { isActive }: ListCatalogQueryDto = {},
  ): Promise<CatalogItem[]> {
    return CATALOGS[kind]
      .table(this.prisma)
      .findMany({ where: { isActive }, orderBy: { name: 'asc' } });
  }

  async findById(kind: CatalogKind, id: string): Promise<CatalogItem> {
    const item = await this.findItem(this.prisma, kind, id);
    if (!item) {
      throw notFound(kind);
    }
    return item;
  }

  /**
   * Para otros modulos: devuelve los registros (activos o no) cuyos ids
   * existen, ordenados por nombre. Los ids invalidos o inexistentes se omiten.
   */
  async findByIds(kind: CatalogKind, ids: string[]): Promise<CatalogItem[]> {
    const validIds = [...new Set(ids)].filter((id) => isUUID(id));
    if (validIds.length === 0) {
      return [];
    }
    return CATALOGS[kind].table(this.prisma).findMany({
      where: { id: { in: validIds } },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Para otros módulos (perfiles de trabajador, pedidos): valida que la
   * categoría o zona exista y esté activa antes de usarla en un registro nuevo.
   */
  async assertActive(kind: CatalogKind, id: string): Promise<CatalogItem> {
    const item = await this.findById(kind, id);
    if (!item.isActive) {
      throw new BadRequestException(
        `La ${CATALOGS[kind].noun} seleccionada no está activa`,
      );
    }
    return item;
  }

  async create(
    kind: CatalogKind,
    actorId: string,
    dto: CreateCatalogItemDto,
  ): Promise<CatalogItem> {
    const name = normalizeName(dto.name);
    const description = normalizeDescription(dto.description);

    return this.inTransaction(kind, async (tx) => {
      await this.assertNameAvailable(tx, kind, name);
      const item = await CATALOGS[kind]
        .table(tx)
        .create({ data: { name, description } });
      await this.audit.record(
        {
          actorId,
          action: AuditAction.CREACION,
          entityType: CATALOGS[kind].entityType,
          entityId: item.id,
          details: { name, description },
        },
        tx,
      );
      return item;
    });
  }

  async update(
    kind: CatalogKind,
    actorId: string,
    id: string,
    dto: UpdateCatalogItemDto,
  ): Promise<CatalogItem> {
    if (dto.name === undefined && dto.description === undefined) {
      throw new BadRequestException(
        'Debe enviar el nombre o la descripción a modificar',
      );
    }

    return this.inTransaction(kind, async (tx) => {
      const current = await this.findItem(tx, kind, id);
      if (!current) {
        throw notFound(kind);
      }

      const changes: { name?: string; description?: string | null } = {};
      if (dto.name !== undefined) {
        const name = normalizeName(dto.name);
        if (name !== current.name) changes.name = name;
      }
      if (dto.description !== undefined) {
        const description = normalizeDescription(dto.description);
        if (description !== current.description) {
          changes.description = description;
        }
      }
      if (Object.keys(changes).length === 0) {
        return current;
      }
      if (changes.name !== undefined) {
        await this.assertNameAvailable(tx, kind, changes.name, id);
      }

      const updated = await CATALOGS[kind]
        .table(tx)
        .update({ where: { id }, data: changes });
      await this.audit.record(
        {
          actorId,
          action: AuditAction.EDICION,
          entityType: CATALOGS[kind].entityType,
          entityId: id,
          details: {
            before: pick(current, changes),
            after: changes,
          },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Desactivación lógica: el registro y sus relaciones se conservan, pero
   * deja de ofrecerse y de aceptarse en registros nuevos (assertActive).
   */
  async deactivate(
    kind: CatalogKind,
    actorId: string,
    id: string,
  ): Promise<CatalogItem> {
    const { noun } = CATALOGS[kind];

    return this.inTransaction(kind, async (tx) => {
      const current = await this.findItem(tx, kind, id);
      if (!current) {
        throw notFound(kind);
      }
      if (!current.isActive) {
        throw new ConflictException(`La ${noun} ya está inactiva`);
      }

      const updated = await CATALOGS[kind]
        .table(tx)
        .update({ where: { id }, data: { isActive: false } });
      await this.audit.record(
        {
          actorId,
          action: AuditAction.DESACTIVACION,
          entityType: CATALOGS[kind].entityType,
          entityId: id,
          details: { name: current.name },
        },
        tx,
      );
      return updated;
    });
  }

  private findItem(
    db: Db,
    kind: CatalogKind,
    id: string,
  ): Promise<CatalogItem | null> {
    return isUUID(id)
      ? CATALOGS[kind].table(db).findUnique({ where: { id } })
      : Promise.resolve(null);
  }

  /**
   * Comprobación previa para dar un mensaje claro (incluido si el duplicado
   * está inactivo). La garantía real es el índice único sobre la columna
   * citext: ante solicitudes simultáneas, PostgreSQL rechaza la segunda.
   */
  private async assertNameAvailable(
    db: Db,
    kind: CatalogKind,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await CATALOGS[kind].table(db).findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
    });
    if (existing) {
      throw duplicateName(kind, existing.isActive);
    }
  }

  private async inTransaction<T>(
    kind: CatalogKind,
    work: (tx: Db) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw duplicateName(kind, true);
      }
      throw error;
    }
  }
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function normalizeDescription(
  description: string | null | undefined,
): string | null {
  const value = description?.trim();
  return value ? value : null;
}

function toOption({ id, name, description }: CatalogItem): CatalogOption {
  return { id, name, description };
}

function pick(
  item: CatalogItem,
  changes: { name?: string; description?: string | null },
): Record<string, string | null> {
  return Object.fromEntries(
    Object.keys(changes).map((key) => [key, item[key as keyof typeof changes]]),
  );
}

function notFound(kind: CatalogKind): NotFoundException {
  return new NotFoundException(`La ${CATALOGS[kind].noun} no existe`);
}

function duplicateName(
  kind: CatalogKind,
  existingIsActive: boolean,
): ConflictException {
  const { noun } = CATALOGS[kind];
  return new ConflictException(
    existingIsActive
      ? `Ya existe una ${noun} con ese nombre`
      : `Ya existe una ${noun} inactiva con ese nombre`,
  );
}
