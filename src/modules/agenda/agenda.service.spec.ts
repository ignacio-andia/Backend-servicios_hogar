import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderStatus } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { OffersService } from '../offers/offers.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import { AgendaService } from './agenda.service.js';
import { CheckAvailabilityDto } from './dto/check-availability.dto.js';

type Fn = ReturnType<typeof vi.fn>;

const WORKER = 'worker-1';
// Lunes 2026-11-30 10:00 en La Paz (UTC-4).
const JOB_START = new Date('2026-11-30T14:00:00.000Z');
const MINUTE = 60_000;

describe('AgendaService (RF-29 a RF-31)', () => {
  let findActiveAssignedOrderIds: Fn;
  let findAcceptedJobSlots: Fn;
  let findOrderSummary: Fn;
  let getOwn: Fn;
  let service: AgendaService;

  beforeEach(() => {
    findActiveAssignedOrderIds = vi.fn().mockResolvedValue(['o1']);
    findAcceptedJobSlots = vi.fn().mockResolvedValue([
      {
        orderId: 'o1',
        proposedStartAt: JOB_START,
        estimatedDurationMinutes: 60,
      },
    ]);
    findOrderSummary = vi.fn().mockResolvedValue({
      orderId: 'o1',
      clientId: 'c1',
      assignedWorkerId: WORKER,
      status: OrderStatus.ACORDADO,
    });
    getOwn = vi.fn().mockResolvedValue({
      schedules: [
        {
          id: 's1',
          dayOfWeek: 'LUNES',
          startTime: '08:00',
          endTime: '18:00',
          isActive: true,
        },
      ],
    });
    const tx = {};
    service = new AgendaService(
      {
        $transaction: (fn: (db: object) => unknown) => fn(tx),
      } as unknown as PrismaService,
      {
        findActiveAssignedOrderIds,
        findOrderSummary,
      } as unknown as OrdersService,
      { findAcceptedJobSlots } as unknown as OffersService,
      { getOwn } as unknown as WorkerProfileService,
    );
  });

  const at = (offsetMinutes: number) =>
    new Date(JOB_START.getTime() + offsetMinutes * MINUTE).toISOString();

  it('lista los trabajos acordados con su rango [inicio, fin)', async () => {
    const agenda = await service.getAgenda(WORKER);
    expect(agenda.timeZone).toBe('America/La_Paz');
    expect(agenda.jobs).toEqual([
      {
        orderId: 'o1',
        orderStatus: OrderStatus.ACORDADO,
        startAt: JOB_START,
        endAt: new Date(JOB_START.getTime() + 60 * MINUTE),
        durationMinutes: 60,
      },
    ]);
    expect(findActiveAssignedOrderIds).toHaveBeenCalledWith(
      expect.anything(),
      WORKER,
    );
  });

  it('solo mira los pedidos que OrdersModule considera activos (cancelados y cerrados liberan la franja)', async () => {
    findActiveAssignedOrderIds.mockResolvedValue([]);
    findAcceptedJobSlots.mockResolvedValue([]);
    expect((await service.getAgenda(WORKER)).jobs).toEqual([]);
    expect(findAcceptedJobSlots).toHaveBeenCalledWith(
      expect.anything(),
      WORKER,
      [],
    );
  });

  it('detecta un cruce y lo informa', async () => {
    const result = await service.checkAvailability(WORKER, {
      startAt: at(30),
      durationMinutes: 60,
    });
    expect(result.available).toBe(false);
    expect(result.conflicts.map((job) => job.orderId)).toEqual(['o1']);
  });

  it('un trabajo contiguo no se cruza (fin == inicio) en ambos sentidos', async () => {
    const after = await service.checkAvailability(WORKER, {
      startAt: at(60),
      durationMinutes: 30,
    });
    const before = await service.checkAvailability(WORKER, {
      startAt: at(-30),
      durationMinutes: 30,
    });
    expect(after.available).toBe(true);
    expect(before.available).toBe(true);
  });

  it('fuera del horario semanal es solo informativo: sigue disponible', async () => {
    // Martes 10:00 local.
    const result = await service.checkAvailability(WORKER, {
      startAt: '2026-12-01T14:00:00.000Z',
      durationMinutes: 60,
    });
    expect(result).toMatchObject({ available: true, withinSchedule: false });
    expect(result.note).toMatch(/fuera de tu horario/);
  });

  it('dentro del horario no agrega notas', async () => {
    const result = await service.checkAvailability(WORKER, {
      startAt: at(120),
      durationMinutes: 30,
    });
    expect(result).toMatchObject({ withinSchedule: true, note: null });
  });

  it('un horario inactivo no cuenta como atencion', async () => {
    getOwn.mockResolvedValue({
      schedules: [
        {
          id: 's1',
          dayOfWeek: 'LUNES',
          startTime: '08:00',
          endTime: '18:00',
          isActive: false,
        },
      ],
    });
    const result = await service.checkAvailability(WORKER, {
      startAt: at(120),
      durationMinutes: 30,
    });
    expect(result.withinSchedule).toBe(false);
  });
});

describe('CheckAvailabilityDto', () => {
  const errorsOf = async (body: object) =>
    (
      await validate(plainToInstance(CheckAvailabilityDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).map((error) => error.property);

  it('acepta fecha con zona y duracion valida', async () => {
    expect(
      await errorsOf({
        startAt: '2026-12-07T10:00:00-04:00',
        durationMinutes: 90,
      }),
    ).toEqual([]);
  });

  it.each(['2026-12-07T10:00:00', '2026-12-07', 'manana'])(
    'rechaza la fecha %s',
    async (startAt) => {
      expect(await errorsOf({ startAt, durationMinutes: 30 })).toContain(
        'startAt',
      );
    },
  );

  it.each([0, -5, 1.5, 30 * 24 * 60 + 1])(
    'rechaza la duracion %s',
    async (durationMinutes) => {
      expect(
        await errorsOf({ startAt: '2026-12-07T10:00:00Z', durationMinutes }),
      ).toContain('durationMinutes');
    },
  );
});
