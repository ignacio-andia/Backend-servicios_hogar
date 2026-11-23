import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { UsersService } from '../users/users.service.js';
import {
  buildWhatsAppContact,
  contactMessage,
  orderReference,
  toWhatsAppNumber,
} from './offer-contact.js';
import { OffersService } from './offers.service.js';

const ORDER_ID = '3f2a9c1d-1234-4abc-9def-0123456789ab';

describe('toWhatsAppNumber (T6.6)', () => {
  it.each([
    ['70000001', '59170000001'],
    ['61234567', '59161234567'],
    ['59170000001', '59170000001'],
    ['+59170000001', '59170000001'],
    ['+591 7000-0001', '59170000001'],
    ['(+591) 700 00 001', '59170000001'],
    ['0059170000001', '59170000001'],
    ['+5491123456789', '5491123456789'],
    ['  +59170000001  ', '59170000001'],
  ])(
    'normaliza %s como %s (solo digitos y con codigo de pais)',
    (input, out) => {
      expect(toWhatsAppNumber(input)).toBe(out);
    },
  );

  it.each([
    [null],
    [undefined],
    [''],
    ['   '],
    ['4123456'], // fijo local, sin codigo de pais
    ['80000001'], // no es celular boliviano
    ['5914123456'],
    ['+0123456789'],
    ['+1234567'], // demasiado corto
    ['+1234567890123456'], // demasiado largo
    ['70000001x'],
  ])('rechaza %s', (input) => {
    expect(toWhatsAppNumber(input)).toBeNull();
  });
});

describe('buildWhatsAppContact (T6.6)', () => {
  it('arma el enlace oficial wa.me con el mensaje codificado', () => {
    const contact = buildWhatsAppContact('70000001', 'TRABAJADOR', ORDER_ID);

    expect(contact).toEqual({
      available: true,
      channel: 'WHATSAPP',
      contactRole: 'TRABAJADOR',
      url:
        'https://wa.me/59170000001?text=' +
        encodeURIComponent(
          'Hola, te escribo por tu oferta para mi pedido 3F2A9C1D en ArreglaloYA.',
        ),
    });
    const url = new URL(contact.url!);
    expect(url.host).toBe('wa.me');
    expect(url.pathname).toBe('/59170000001');
    expect(url.searchParams.get('text')).toBe(
      contactMessage('TRABAJADOR', ORDER_ID),
    );
    // Codificacion: sin espacios ni tildes crudas en el enlace.
    expect(contact.url).not.toMatch(/[ áéíóúñ]/);
  });

  it('el mensaje solo identifica el pedido por su referencia corta', () => {
    expect(orderReference(ORDER_ID)).toBe('3F2A9C1D');
    expect(contactMessage('CLIENTE', ORDER_ID)).toBe(
      'Hola, te escribo por mi oferta para tu pedido 3F2A9C1D en ArreglaloYA.',
    );
    expect(contactMessage('CLIENTE', ORDER_ID)).not.toContain(ORDER_ID);
  });

  it('sin telefono o con uno invalido devuelve un resultado controlado sin enlace', () => {
    expect(buildWhatsAppContact(null, 'CLIENTE', ORDER_ID)).toEqual({
      available: false,
      channel: 'WHATSAPP',
      contactRole: 'CLIENTE',
      url: null,
      reason: 'TELEFONO_NO_REGISTRADO',
    });
    expect(buildWhatsAppContact('4123456', 'CLIENTE', ORDER_ID)).toEqual({
      available: false,
      channel: 'WHATSAPP',
      contactRole: 'CLIENTE',
      url: null,
      reason: 'TELEFONO_INVALIDO',
    });
  });
});

describe('OffersService: contacto por WhatsApp (T6.6)', () => {
  let prisma: { offer: { findFirst: ReturnType<typeof vi.fn> } };
  let users: { findById: ReturnType<typeof vi.fn> };
  let service: OffersService;

  beforeEach(() => {
    prisma = { offer: { findFirst: vi.fn() } };
    users = { findById: vi.fn().mockResolvedValue({ phone: '+59170000002' }) };
    service = new OffersService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      users as unknown as UsersService,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('el trabajador solo obtiene el contacto del cliente de su propia oferta', async () => {
    prisma.offer.findFirst.mockResolvedValue({
      orderId: ORDER_ID,
      order: { clientId: 'cliente-1' },
    });

    const contact = await service.workerContact('trabajador-1', 'oferta-1');

    expect(prisma.offer.findFirst.mock.calls[0][0].where).toEqual({
      id: 'oferta-1',
      workerId: 'trabajador-1',
    });
    expect(users.findById).toHaveBeenCalledWith('cliente-1');
    expect(contact).toMatchObject({ available: true, contactRole: 'CLIENTE' });
  });

  it('el cliente solo obtiene el contacto del trabajador de ofertas de sus pedidos', async () => {
    prisma.offer.findFirst.mockResolvedValue({
      orderId: ORDER_ID,
      workerId: 'trabajador-1',
    });

    const contact = await service.clientContact('cliente-1', 'oferta-1');

    expect(prisma.offer.findFirst.mock.calls[0][0].where).toEqual({
      AND: [{ id: 'oferta-1' }, { order: { clientId: 'cliente-1' } }],
    });
    expect(users.findById).toHaveBeenCalledWith('trabajador-1');
    expect(contact).toMatchObject({
      available: true,
      contactRole: 'TRABAJADOR',
    });
  });

  it('una oferta ajena responde 404 sin leer ningun telefono', async () => {
    prisma.offer.findFirst.mockResolvedValue(null);

    await expect(
      service.workerContact('otro', 'oferta-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.clientContact('otro', 'oferta-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(users.findById).not.toHaveBeenCalled();
  });
});
