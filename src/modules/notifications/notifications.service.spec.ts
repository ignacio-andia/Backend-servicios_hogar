import { NotFoundException } from '@nestjs/common';
import {
  NotificationResourceType,
  NotificationType,
  RoleName,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

const USER_ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const OTHER_ID = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';
const NOTIFICATION_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

const mockFns = <K extends string>(...names: K[]) =>
  Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<
    K,
    ReturnType<typeof vi.fn>
  >;

const NEW = {
  type: NotificationType.VERIFICACION_SOLICITADA,
  title: 'Nueva solicitud de verificación',
  message: 'Un trabajador envió su perfil a verificación.',
  resource: {
    type: NotificationResourceType.PERFIL_TRABAJADOR,
    id: PROFILE_ID,
  },
};

describe('NotificationsService', () => {
  let prisma: {
    notification: Record<
      | 'create'
      | 'createMany'
      | 'findMany'
      | 'findFirst'
      | 'count'
      | 'updateMany',
      ReturnType<typeof vi.fn>
    >;
    user: Record<'findMany', ReturnType<typeof vi.fn>>;
    $transaction: ReturnType<typeof vi.fn>;
  };
  let service: NotificationsService;

  beforeEach(() => {
    prisma = {
      notification: mockFns(
        'create',
        'createMany',
        'findMany',
        'findFirst',
        'count',
        'updateMany',
      ),
      user: mockFns('findMany'),
      // El listado usa la forma de arreglo de $transaction.
      $transaction: vi.fn((queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
    };
    service = new NotificationsService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('guarda la notificacion con su recurso', async () => {
      await service.create(USER_ID, NEW);

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          type: NotificationType.VERIFICACION_SOLICITADA,
          title: NEW.title,
          message: NEW.message,
          resourceType: NotificationResourceType.PERFIL_TRABAJADOR,
          resourceId: PROFILE_ID,
        },
      });
    });

    it('sin recurso guarda tipo e id nulos', async () => {
      await service.create(USER_ID, { ...NEW, resource: undefined });

      expect(prisma.notification.create.mock.calls[0][0]).toMatchObject({
        data: { resourceType: null, resourceId: null },
      });
    });

    it('usa el cliente de la transaccion recibido', async () => {
      const tx = { notification: mockFns('create') };

      await service.create(USER_ID, NEW, tx as never);

      expect(tx.notification.create).toHaveBeenCalledTimes(1);
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('propaga el error para que la transaccion del evento se revierta', async () => {
      prisma.notification.create.mockRejectedValue(new Error('fallo'));

      await expect(service.create(USER_ID, NEW)).rejects.toThrow('fallo');
    });
  });

  describe('createForRole', () => {
    it('crea una por cada usuario activo con el rol, salvo los excluidos', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: USER_ID },
        { id: OTHER_ID },
      ]);
      prisma.notification.createMany.mockResolvedValue({ count: 2 });

      await expect(
        service.createForRole(RoleName.ADMINISTRADOR, NEW, {
          excludeUserIds: ['excluido'],
        }),
      ).resolves.toBe(2);

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          status: UserStatus.ACTIVO,
          roles: { some: { role: RoleName.ADMINISTRADOR } },
          id: { notIn: ['excluido'] },
        },
        select: { id: true },
      });
      const { data } = prisma.notification.createMany.mock.calls[0][0] as {
        data: { userId: string }[];
      };
      expect(data.map((item) => item.userId)).toEqual([USER_ID, OTHER_ID]);
    });

    it('sin destinatarios no inserta nada', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await expect(
        service.createForRole(RoleName.ADMINISTRADOR, NEW),
      ).resolves.toBe(0);
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('consulta e inserta con el cliente de la transaccion', async () => {
      const tx = {
        user: { findMany: vi.fn().mockResolvedValue([{ id: USER_ID }]) },
        notification: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };

      await service.createForRole(RoleName.ADMINISTRADOR, NEW, {}, tx as never);

      expect(tx.user.findMany).toHaveBeenCalledTimes(1);
      expect(tx.notification.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    beforeEach(() => {
      prisma.notification.findMany.mockResolvedValue([]);
      prisma.notification.count.mockResolvedValue(45);
    });

    it('pagina solo las del usuario, de la mas reciente a la mas antigua', async () => {
      const result = await service.list(USER_ID, { page: 3, limit: 20 });

      expect(prisma.notification.findMany.mock.calls[0][0]).toMatchObject({
        where: { userId: USER_ID },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 40,
        take: 20,
      });
      expect(result.meta).toEqual({
        page: 3,
        limit: 20,
        total: 45,
        totalPages: 3,
      });
    });

    it.each([
      [true, { readAt: null }],
      [false, { readAt: { not: null } }],
    ])('unread=%s filtra por readAt', async (unread, filter) => {
      await service.list(USER_ID, { unread, page: 1, limit: 20 });

      expect(prisma.notification.findMany.mock.calls[0][0].where).toEqual({
        userId: USER_ID,
        ...filter,
      });
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { userId: USER_ID, ...filter },
      });
    });
  });

  it('cuenta solo las no leidas del usuario', async () => {
    prisma.notification.count.mockResolvedValue(4);

    await expect(service.countUnread(USER_ID)).resolves.toEqual({ unread: 4 });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { userId: USER_ID, readAt: null },
    });
  });

  describe('markAsRead', () => {
    it('marca solo si es propia y no leida, y devuelve la vista', async () => {
      const view = { id: NOTIFICATION_ID, readAt: new Date() };
      prisma.notification.findFirst.mockResolvedValue(view);

      await expect(service.markAsRead(USER_ID, NOTIFICATION_ID)).resolves.toBe(
        view,
      );
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: NOTIFICATION_ID, userId: USER_ID, readAt: null },
        data: { readAt: expect.any(Date) },
      });
      expect(prisma.notification.findFirst.mock.calls[0][0]).toMatchObject({
        where: { id: NOTIFICATION_ID, userId: USER_ID },
      });
    });

    it('una notificacion ajena o inexistente responde 404', async () => {
      prisma.notification.findFirst.mockResolvedValue(null);

      await expect(
        service.markAsRead(USER_ID, NOTIFICATION_ID),
      ).rejects.toThrow(new NotFoundException('La notificación no existe'));
    });
  });

  it('markAllAsRead marca las no leidas del usuario y devuelve cuantas', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });

    await expect(service.markAllAsRead(USER_ID)).resolves.toEqual({
      updated: 3,
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });
});
