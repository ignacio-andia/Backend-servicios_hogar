import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  CatalogItem,
  CatalogKind,
  CatalogsService,
} from './catalogs.service.js';

const ADMIN_ID = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';
const ITEM_ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';

const item = (overrides: Partial<CatalogItem> = {}): CatalogItem => ({
  id: ITEM_ID,
  name: 'Plomería',
  description: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

type TableMock = Record<
  'findMany' | 'findUnique' | 'findFirst' | 'create' | 'update',
  ReturnType<typeof vi.fn>
>;

const tableMock = (): TableMock => ({
  findMany: vi.fn().mockResolvedValue([]),
  findUnique: vi.fn().mockResolvedValue(null),
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn(),
  update: vi.fn(),
});

describe('CatalogsService', () => {
  let prisma: {
    serviceCategory: TableMock;
    zone: TableMock;
    $transaction: ReturnType<typeof vi.fn>;
  };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: CatalogsService;

  beforeEach(() => {
    prisma = {
      serviceCategory: tableMock(),
      zone: tableMock(),
      $transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) =>
        work(prisma),
      ),
    };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new CatalogsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  describe('consultas', () => {
    it('la consulta pública solo pide registros activos y omite campos internos', async () => {
      prisma.zone.findMany.mockResolvedValue([item({ name: 'Zona A' })]);

      const options = await service.findActive(CatalogKind.ZONE);

      expect(prisma.zone.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      });
      expect(options).toEqual([
        { id: ITEM_ID, name: 'Zona A', description: null },
      ]);
    });

    it('la consulta administrativa filtra por estado solo si se indica', async () => {
      await service.findAll(CatalogKind.CATEGORY, {});
      await service.findAll(CatalogKind.CATEGORY, { isActive: false });

      expect(prisma.serviceCategory.findMany.mock.calls[0][0].where).toEqual({
        isActive: undefined,
      });
      expect(prisma.serviceCategory.findMany.mock.calls[1][0].where).toEqual({
        isActive: false,
      });
    });

    it('findActiveById oculta registros inactivos', async () => {
      prisma.serviceCategory.findUnique.mockResolvedValue(
        item({ isActive: false }),
      );

      await expect(
        service.findActiveById(CatalogKind.CATEGORY, ITEM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('findById responde NotFound sin consultar si el id no es UUID', async () => {
      await expect(
        service.findById(CatalogKind.ZONE, 'abc'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.zone.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('findByIds', () => {
    it('consulta una sola vez, sin duplicados ni ids invalidos', async () => {
      prisma.serviceCategory.findMany.mockResolvedValue([item()]);

      const result = await service.findByIds(CatalogKind.CATEGORY, [
        ITEM_ID,
        ITEM_ID,
        'no-es-uuid',
      ]);

      expect(prisma.serviceCategory.findMany).toHaveBeenCalledWith({
        where: { id: { in: [ITEM_ID] } },
        orderBy: { name: 'asc' },
      });
      expect(result).toHaveLength(1);
    });

    it('no consulta si no hay ids validos', async () => {
      await expect(service.findByIds(CatalogKind.ZONE, [])).resolves.toEqual(
        [],
      );
      expect(prisma.zone.findMany).not.toHaveBeenCalled();
    });
  });

  describe('assertActive', () => {
    it('rechaza una categoría inactiva para registros nuevos', async () => {
      prisma.serviceCategory.findUnique.mockResolvedValue(
        item({ isActive: false }),
      );

      await expect(
        service.assertActive(CatalogKind.CATEGORY, ITEM_ID),
      ).rejects.toThrow(
        new BadRequestException('La categoría seleccionada no está activa'),
      );
    });

    it('rechaza una zona inexistente', async () => {
      await expect(
        service.assertActive(CatalogKind.ZONE, ITEM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('devuelve el registro activo', async () => {
      prisma.zone.findUnique.mockResolvedValue(item({ name: 'Zona A' }));

      await expect(
        service.assertActive(CatalogKind.ZONE, ITEM_ID),
      ).resolves.toMatchObject({ name: 'Zona A' });
    });
  });

  describe('create', () => {
    it('normaliza los datos, crea activo y registra la acción en la misma transacción', async () => {
      prisma.serviceCategory.create.mockResolvedValue(
        item({ name: 'Pintura' }),
      );

      await service.create(CatalogKind.CATEGORY, ADMIN_ID, {
        name: '  Pintura   de   interiores ',
        description: '   ',
      });

      expect(prisma.serviceCategory.findFirst).toHaveBeenCalledWith({
        where: {
          name: { equals: 'Pintura de interiores', mode: 'insensitive' },
        },
      });
      expect(prisma.serviceCategory.create).toHaveBeenCalledWith({
        data: { name: 'Pintura de interiores', description: null },
      });
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorId: ADMIN_ID,
          action: AuditAction.CREACION,
          entityType: AuditEntityType.CATEGORIA_SERVICIO,
          entityId: ITEM_ID,
          details: { name: 'Pintura de interiores', description: null },
        },
        prisma,
      );
    });

    it('rechaza nombres duplicados sin distinguir mayúsculas', async () => {
      prisma.zone.findFirst.mockResolvedValue(item({ name: 'Zona A' }));

      await expect(
        service.create(CatalogKind.ZONE, ADMIN_ID, { name: 'zona a' }),
      ).rejects.toThrow(
        new ConflictException('Ya existe una zona con ese nombre'),
      );
      expect(prisma.zone.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('avisa si el duplicado es un registro inactivo', async () => {
      prisma.zone.findFirst.mockResolvedValue(
        item({ name: 'Zona A', isActive: false }),
      );

      await expect(
        service.create(CatalogKind.ZONE, ADMIN_ID, { name: 'Zona A' }),
      ).rejects.toThrow('Ya existe una zona inactiva con ese nombre');
    });

    it('traduce una violación de unicidad concurrente a 409', async () => {
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.create(CatalogKind.CATEGORY, ADMIN_ID, { name: 'Pintura' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('no completa la acción si falla el registro en la bitácora', async () => {
      prisma.serviceCategory.create.mockResolvedValue(item());
      audit.record.mockRejectedValue(new Error('bitácora no disponible'));

      await expect(
        service.create(CatalogKind.CATEGORY, ADMIN_ID, { name: 'Pintura' }),
      ).rejects.toThrow('bitácora no disponible');
    });
  });

  describe('update', () => {
    it('exige al menos un campo', async () => {
      await expect(
        service.update(CatalogKind.ZONE, ADMIN_ID, ITEM_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('responde NotFound si el registro no existe', async () => {
      await expect(
        service.update(CatalogKind.ZONE, ADMIN_ID, ITEM_ID, { name: 'X Y' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('permite cambiar solo mayúsculas del propio nombre', async () => {
      prisma.serviceCategory.findUnique.mockResolvedValue(
        item({ name: 'plomería' }),
      );
      prisma.serviceCategory.update.mockResolvedValue(item());

      await service.update(CatalogKind.CATEGORY, ADMIN_ID, ITEM_ID, {
        name: 'Plomería',
      });

      expect(prisma.serviceCategory.findFirst.mock.calls[0][0].where).toEqual({
        name: { equals: 'Plomería', mode: 'insensitive' },
        NOT: { id: ITEM_ID },
      });
    });

    it('registra en la bitácora solo los campos que cambiaron', async () => {
      prisma.serviceCategory.findUnique.mockResolvedValue(
        item({ description: 'Antes' }),
      );
      prisma.serviceCategory.update.mockResolvedValue(
        item({ description: 'Después' }),
      );

      await service.update(CatalogKind.CATEGORY, ADMIN_ID, ITEM_ID, {
        name: 'Plomería',
        description: 'Después',
      });

      expect(prisma.serviceCategory.update).toHaveBeenCalledWith({
        where: { id: ITEM_ID },
        data: { description: 'Después' },
      });
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AuditAction.EDICION,
        details: {
          before: { description: 'Antes' },
          after: { description: 'Después' },
        },
      });
    });

    it('no escribe nada si no hay cambios reales', async () => {
      prisma.serviceCategory.findUnique.mockResolvedValue(item());

      const result = await service.update(
        CatalogKind.CATEGORY,
        ADMIN_ID,
        ITEM_ID,
        { name: ' Plomería ' },
      );

      expect(result.name).toBe('Plomería');
      expect(prisma.serviceCategory.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('rechaza renombrar a un nombre que ya usa otro registro', async () => {
      prisma.zone.findUnique.mockResolvedValue(item({ name: 'Zona A' }));
      prisma.zone.findFirst.mockResolvedValue(
        item({ id: 'otro', name: 'Zona B' }),
      );

      await expect(
        service.update(CatalogKind.ZONE, ADMIN_ID, ITEM_ID, { name: 'zona b' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.zone.update).not.toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    it('cambia solo el estado y registra la acción', async () => {
      prisma.zone.findUnique.mockResolvedValue(item({ name: 'Zona A' }));
      prisma.zone.update.mockResolvedValue(
        item({ name: 'Zona A', isActive: false }),
      );

      const result = await service.deactivate(
        CatalogKind.ZONE,
        ADMIN_ID,
        ITEM_ID,
      );

      expect(prisma.zone.update).toHaveBeenCalledWith({
        where: { id: ITEM_ID },
        data: { isActive: false },
      });
      expect(audit.record.mock.calls[0][0]).toEqual({
        actorId: ADMIN_ID,
        action: AuditAction.DESACTIVACION,
        entityType: AuditEntityType.ZONA,
        entityId: ITEM_ID,
        details: { name: 'Zona A' },
      });
      expect(result.isActive).toBe(false);
    });

    it('responde 409 si ya estaba inactivo', async () => {
      prisma.zone.findUnique.mockResolvedValue(item({ isActive: false }));

      await expect(
        service.deactivate(CatalogKind.ZONE, ADMIN_ID, ITEM_ID),
      ).rejects.toThrow(new ConflictException('La zona ya está inactiva'));
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
