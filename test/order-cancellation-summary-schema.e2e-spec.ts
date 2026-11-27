//=========================================================
// NUEVO: order-cancellation-summary-schema.e2e-spec.ts
// Fase B3 (cancelacion): verifica la migracion de
// order_cancellation_summaries (estructura, relaciones, unicidad, formulas,
// controles e inmutabilidad). No hay todavia servicio que escriba en la tabla:
// las filas se insertan directamente.
// Reglas economicas comprobadas: total = acordado + adicionales aceptados;
// saldo = total - anticipos confirmados; visita aparte; lo declarado sin
// confirmar no reduce el saldo; sin acuerdo los importes son NULL.
// Corre SIEMPRE en un esquema temporal: nunca toca el esquema public.
//=========================================================
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OfferStatus } from '../src/generated/prisma/client.js';
import {
  createIsolatedSchema,
  IsolatedSchema,
} from './utils/isolated-schema.js';

const TABLE = 'order_cancellation_summaries';

describe('Persistencia del resumen economico de cancelacion (B3, e2e)', () => {
  let isolated: IsolatedSchema;
  /** SQL directo: entrega el codigo y la restriccion que reporta PostgreSQL. */
  let db: pg.Client;
  let clientId: string;
  let workerId: string;
  let categoryId: string;
  let zoneId: string;

  beforeAll(async () => {
    isolated = await createIsolatedSchema('summary');
    db = new pg.Client({
      connectionString: process.env.DATABASE_URL!,
      options: `-c TimeZone=UTC -c search_path=${isolated.schema},public`,
    });
    await db.connect();
    const newUser = async (name: string) =>
      (
        await isolated.prisma.user.create({
          data: {
            firstName: name,
            lastName: 'E2E',
            email: `${name}-${randomUUID()}@summary-e2e.test`,
            passwordHash: 'hash',
          },
        })
      ).id;
    clientId = await newUser('client');
    workerId = await newUser('worker');
    categoryId = (
      await isolated.prisma.serviceCategory.create({
        data: { name: 'Plomeria resumen' },
      })
    ).id;
    zoneId = (
      await isolated.prisma.zone.create({ data: { name: 'Zona resumen' } })
    ).id;
  });

  afterAll(async () => {
    await db?.end();
    await isolated?.drop();
  });

  const newOrder = async () =>
    (
      await isolated.prisma.order.create({
        data: {
          clientId,
          categoryId,
          zoneId,
          description: 'Fuga de agua en la cocina',
          budgetAmount: '400.00',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
    ).id;

  const newAcceptedOffer = async (orderId: string) =>
    (
      await isolated.prisma.offer.create({
        data: {
          orderId,
          workerId,
          status: OfferStatus.ACEPTADA,
          amount: '400.00',
          requiresVisit: false,
          materialsIncluded: false,
          proposedStartAt: new Date(Date.now() + 86_400_000),
          estimatedDurationMinutes: 60,
          expiresAt: new Date(Date.now() + 86_400_000),
          closedAt: new Date(),
        },
      })
    ).id;

  const agreedOrder = async () => {
    const orderId = await newOrder();
    return { orderId, offerId: await newAcceptedOffer(orderId) };
  };

  type Row = Record<string, string | number | null>;

  /** Fila valida con acuerdo: 400 + 0 - 100 = 300. */
  const withAgreement = (
    ids: { orderId: string; offerId: string },
    changes: Row = {},
  ): Row => ({
    order_id: ids.orderId,
    accepted_offer_id: ids.offerId,
    agreed_at: new Date().toISOString(),
    agreed_amount: '400.00',
    accepted_additional_total: '0.00',
    updated_total: '400.00',
    confirmed_advance_total: '100.00',
    unconfirmed_advance_amount: null,
    pending_balance: '300.00',
    visit_cost: null,
    details: '{}',
    ...changes,
  });

  const withoutAgreement = (orderId: string, changes: Row = {}): Row => ({
    order_id: orderId,
    details: '{}',
    ...changes,
  });

  const insert = (row: Row) => {
    const columns = Object.keys(row);
    return db.query(
      `INSERT INTO "${TABLE}" (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };

  const allRows = async () =>
    (await db.query(`SELECT * FROM "${TABLE}" ORDER BY "order_id"`)).rows;

  describe('estructura', () => {
    it('tiene las columnas, tipos y nulabilidad definidos', async () => {
      const result = await db.query<{
        name: string;
        type: string;
        precision: number | null;
        scale: number | null;
        nullable: string;
      }>(
        `SELECT column_name AS "name", udt_name AS "type",
                numeric_precision AS "precision", numeric_scale AS "scale",
                is_nullable AS "nullable"
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [isolated.schema, TABLE],
      );
      const rows = result.rows.map((c) => ({
        column: [
          c.name,
          c.type === 'numeric' ? `numeric(${c.precision},${c.scale})` : c.type,
          ...(c.nullable === 'NO' ? ['NOT NULL'] : []),
        ].join(' '),
      }));
      expect(rows.map((r) => r.column)).toEqual([
        'order_id uuid NOT NULL',
        'captured_at timestamptz NOT NULL',
        'accepted_offer_id uuid',
        'agreed_at timestamptz',
        'agreed_amount numeric(10,2)',
        'accepted_additional_total numeric(12,2)',
        'updated_total numeric(12,2)',
        'confirmed_advance_total numeric(10,2)',
        'unconfirmed_advance_amount numeric(10,2)',
        'pending_balance numeric(12,2)',
        'visit_cost numeric(10,2)',
        'details jsonb NOT NULL',
        'schema_version int2 NOT NULL',
      ]);
    });

    it('declara clave primaria, relaciones, controles y triggers', async () => {
      const table = `"${isolated.schema}"."${TABLE}"`;
      const constraints = await db.query<{ name: string; type: string }>(
        `SELECT conname AS "name", contype::text AS "type" FROM pg_constraint
         WHERE conrelid = $1::regclass AND contype <> 'n' ORDER BY conname`,
        [table],
      );
      expect(constraints.rows.map((c) => `${c.type} ${c.name}`)).toEqual([
        `c ${TABLE}_advance_check`,
        `c ${TABLE}_agreement_check`,
        `c ${TABLE}_amounts_check`,
        `c ${TABLE}_balance_check`,
        `c ${TABLE}_details_check`,
        `f ${TABLE}_offer_order_fkey`,
        `f ${TABLE}_order_id_fkey`,
        `p ${TABLE}_pkey`,
        `c ${TABLE}_total_check`,
        `c ${TABLE}_version_check`,
      ]);
      const triggers = await db.query<{ name: string; enabled: string }>(
        `SELECT tgname AS "name", tgenabled AS "enabled" FROM pg_trigger
         WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname`,
        [table],
      );
      expect(triggers.rows).toEqual([
        { name: `${TABLE}_no_truncate`, enabled: 'O' },
        { name: `${TABLE}_no_update_delete`, enabled: 'O' },
      ]);
    });
  });

  describe('fotografias validas', () => {
    it('con acuerdo: se escribe y se lee con el modelo de Prisma', async () => {
      const { orderId, offerId } = await agreedOrder();
      const before = Date.now();
      await isolated.prisma.orderCancellationSummary.create({
        data: {
          orderId,
          acceptedOfferId: offerId,
          agreedAt: new Date(),
          agreedAmount: '400.00',
          acceptedAdditionalTotal: '50.00',
          updatedTotal: '450.00',
          confirmedAdvanceTotal: '100.00',
          pendingBalance: '350.00',
          visitCost: '30.00',
          details: { declarations: [] },
        },
      });
      const stored = await isolated.prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { cancellationSummary: { include: { acceptedOffer: true } } },
      });
      const summary = stored.cancellationSummary!;
      expect(summary.acceptedOffer?.id).toBe(offerId);
      expect(summary.updatedTotal?.toFixed(2)).toBe('450.00');
      expect(summary.pendingBalance?.toFixed(2)).toBe('350.00');
      expect(summary.unconfirmedAdvanceAmount).toBeNull();
      expect(summary.details).toEqual({ declarations: [] });
      expect(summary.schemaVersion).toBe(1);
      expect(Math.abs(summary.capturedAt.getTime() - before)).toBeLessThan(
        5_000,
      );
    });

    it('sin acuerdo: todos los importes quedan NULL, no cero', async () => {
      const orderId = await newOrder();
      await isolated.prisma.orderCancellationSummary.create({
        data: { orderId, details: {} },
      });
      expect(
        await isolated.prisma.orderCancellationSummary.findUniqueOrThrow({
          where: { orderId },
        }),
      ).toMatchObject({
        acceptedOfferId: null,
        agreedAt: null,
        agreedAmount: null,
        acceptedAdditionalTotal: null,
        updatedTotal: null,
        confirmedAdvanceTotal: null,
        unconfirmedAdvanceAmount: null,
        pendingBalance: null,
        visitCost: null,
      });
    });

    it.each([
      [
        'anticipo declarado sin confirmar: no reduce el saldo',
        {
          confirmed_advance_total: '0.00',
          unconfirmed_advance_amount: '100.00',
          pending_balance: '400.00',
        },
      ],
      [
        'sin anticipos',
        { confirmed_advance_total: '0.00', pending_balance: '400.00' },
      ],
      ['visita aparte del total', { visit_cost: '30.00' }],
      ['visita sin costo', { visit_cost: '0.00' }],
      ['fecha del acuerdo no disponible', { agreed_at: null }],
      [
        'totales mayores que un monto individual',
        {
          agreed_amount: '99999999.99',
          accepted_additional_total: '99999999.99',
          updated_total: '199999999.98',
          pending_balance: '199999899.98',
        },
      ],
      [
        'saldo negativo (sin control de signo propio)',
        { confirmed_advance_total: '500.00', pending_balance: '-100.00' },
      ],
    ])('acepta: %s', async (_label, changes: Row) => {
      const ids = await agreedOrder();
      await expect(insert(withAgreement(ids, changes))).resolves.toMatchObject({
        rowCount: 1,
      });
    });
  });

  describe('controles de integridad', () => {
    let ids: { orderId: string; offerId: string };
    beforeAll(async () => {
      ids = await agreedOrder();
    });

    const rejects = async (row: Row, constraint: string) => {
      const before = await allRows();
      await expect(insert(row)).rejects.toMatchObject({
        code: '23514',
        constraint: `${TABLE}_${constraint}`,
      });
      expect(await allRows()).toEqual(before);
    };

    it.each([
      'agreed_amount',
      'accepted_additional_total',
      'updated_total',
      'confirmed_advance_total',
      'pending_balance',
    ])('con acuerdo exige %s', async (column) => {
      await rejects(withAgreement(ids, { [column]: null }), 'agreement_check');
    });

    it.each([
      ['agreed_at', '2026-01-01T00:00:00Z'],
      ['agreed_amount', '0.00'],
      ['accepted_additional_total', '0.00'],
      ['updated_total', '0.00'],
      ['confirmed_advance_total', '0.00'],
      ['unconfirmed_advance_amount', '100.00'],
      ['pending_balance', '0.00'],
      ['visit_cost', '30.00'],
    ])('sin acuerdo no admite %s, ni en cero', async (column, value) => {
      await rejects(
        withoutAgreement(ids.orderId, { [column]: value }),
        'agreement_check',
      );
    });

    it.each<[string, Row, string]>([
      [
        'un total que suma la visita',
        {
          visit_cost: '30.00',
          updated_total: '430.00',
          pending_balance: '330.00',
        },
        'total_check',
      ],
      [
        'un total que ignora los adicionales',
        { accepted_additional_total: '50.00' },
        'total_check',
      ],
      [
        'un saldo que resta lo declarado sin confirmar',
        {
          confirmed_advance_total: '0.00',
          unconfirmed_advance_amount: '100.00',
          pending_balance: '300.00',
        },
        'balance_check',
      ],
      [
        'un saldo que resta un anticipo esperado no confirmado',
        { confirmed_advance_total: '0.00', pending_balance: '300.00' },
        'balance_check',
      ],
      [
        'monto acordado cero',
        {
          agreed_amount: '0.00',
          updated_total: '0.00',
          pending_balance: '-100.00',
        },
        'amounts_check',
      ],
      [
        'adicionales negativos',
        {
          accepted_additional_total: '-10.00',
          updated_total: '390.00',
          pending_balance: '290.00',
        },
        'amounts_check',
      ],
      [
        'anticipo confirmado negativo',
        { confirmed_advance_total: '-1.00', pending_balance: '401.00' },
        'amounts_check',
      ],
      [
        'declaracion sin confirmar en cero',
        {
          confirmed_advance_total: '0.00',
          unconfirmed_advance_amount: '0.00',
          pending_balance: '400.00',
        },
        'amounts_check',
      ],
      ['visita negativa', { visit_cost: '-1.00' }, 'amounts_check'],
      [
        'un anticipo a la vez confirmado y sin confirmar',
        { unconfirmed_advance_amount: '100.00' },
        'advance_check',
      ],
      ['un detalle que no es un objeto', { details: '[]' }, 'details_check'],
      ['version de formato cero', { schema_version: 0 }, 'version_check'],
    ])('rechaza %s', async (_label, changes, constraint) => {
      await rejects(withAgreement(ids, changes), constraint);
    });

    it('exige el detalle', async () => {
      await expect(
        insert(withAgreement(ids, { details: null })),
      ).rejects.toMatchObject({ code: '23502', column: 'details' });
    });
  });

  describe('relaciones y unicidad', () => {
    it('exige un pedido existente', async () => {
      await expect(
        insert(withoutAgreement(randomUUID())),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: `${TABLE}_order_id_fkey`,
      });
    });

    it.each([
      ['de otro pedido', async () => (await agreedOrder()).offerId],
      ['inexistente', () => Promise.resolve(randomUUID())],
    ])('rechaza una oferta %s', async (_label, offer) => {
      const { orderId } = await agreedOrder();
      await expect(
        insert(withAgreement({ orderId, offerId: await offer() })),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: `${TABLE}_offer_order_fkey`,
      });
    });

    it('admite un solo resumen por pedido', async () => {
      const ids = await agreedOrder();
      await insert(withAgreement(ids));
      for (const row of [withAgreement(ids), withoutAgreement(ids.orderId)]) {
        await expect(insert(row)).rejects.toMatchObject({
          code: '23505',
          constraint: `${TABLE}_pkey`,
        });
      }
    });

    it('inserciones simultaneas dejan un solo resumen', async () => {
      const orderId = await newOrder();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          isolated.prisma.orderCancellationSummary.create({
            data: { orderId, details: {} },
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await isolated.prisma.orderCancellationSummary.count({
          where: { orderId },
        }),
      ).toBe(1);
    });

    it('impide borrar el pedido que tiene resumen', async () => {
      const orderId = await newOrder();
      await insert(withoutAgreement(orderId));
      await expect(
        db.query('DELETE FROM "orders" WHERE "id" = $1', [orderId]),
      ).rejects.toMatchObject({ constraint: `${TABLE}_order_id_fkey` });
    });

    it('la clave foranea protege la oferta aunque se omitan sus triggers', async () => {
      const ids = await agreedOrder();
      await insert(withAgreement(ids));
      const remove = () =>
        db.query('DELETE FROM "offers" WHERE "id" = $1', [ids.offerId]);
      // En uso normal una oferta cerrada ya no se borra (su propio trigger).
      await expect(remove()).rejects.toMatchObject({ code: '42501' });
      // Aun en mantenimiento, la relacion con el resumen lo impide.
      await db.query('BEGIN');
      try {
        await db.query(
          `SELECT set_config('app.audit_maintenance', 'on', true)`,
        );
        await expect(remove()).rejects.toMatchObject({
          constraint: `${TABLE}_offer_order_fkey`,
        });
      } finally {
        await db.query('ROLLBACK');
      }
    });

    it('conserva la fotografia aunque despues cambien datos del pedido', async () => {
      const ids = await agreedOrder();
      await insert(withAgreement(ids));
      const read = () =>
        isolated.prisma.orderCancellationSummary.findUniqueOrThrow({
          where: { orderId: ids.orderId },
        });
      const before = await read();
      // El cobro de la visita puede declararse despues de cancelar.
      await isolated.prisma.payment.create({
        data: {
          orderId: ids.orderId,
          concept: 'VISITA',
          expectedAmount: '30.00',
          declarations: {
            create: {
              declaredBy: 'TRABAJADOR',
              userId: workerId,
              method: 'EFECTIVO',
              amount: '30.00',
            },
          },
        },
      });
      await isolated.prisma.additionalBudget.create({
        data: {
          orderId: ids.orderId,
          amount: '999.00',
          reason: 'Registro posterior',
          materials: 'Ninguno',
          status: 'ACEPTADO',
          respondedAt: new Date(),
        },
      });
      await isolated.prisma.order.update({
        where: { id: ids.orderId },
        data: { budgetAmount: '999.00' },
      });
      expect(await read()).toEqual(before);
    });
  });

  describe('inmutabilidad', () => {
    beforeAll(async () => {
      await insert(withAgreement(await agreedOrder()));
    });

    it.each([
      ['UPDATE', `UPDATE "${TABLE}" SET "details" = '{"alterado": true}'`],
      ['DELETE', `DELETE FROM "${TABLE}"`],
      ['TRUNCATE', `TRUNCATE "${TABLE}"`],
    ])('rechaza %s mediante el trigger (42501)', async (operation, sql) => {
      const before = await allRows();
      expect(before.length).toBeGreaterThan(0);
      await expect(db.query(sql)).rejects.toMatchObject({
        code: '42501',
        message: `La tabla ${TABLE} es de solo inserción (${operation} no permitido)`,
        where: expect.stringContaining('append_only_guard()') as unknown,
      });
      expect(await allRows()).toEqual(before);
    });
  });
});
