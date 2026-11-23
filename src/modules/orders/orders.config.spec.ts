import { ConfigService } from '@nestjs/config';
import { OrdersConfig } from './orders.config.js';
import { ORDER_MAX_IMAGES } from './orders.rules.js';

describe('OrdersConfig: fotos por pedido (T5.3)', () => {
  it('el maximo es 4 y no depende del entorno', () => {
    expect(ORDER_MAX_IMAGES).toBe(4);
    const settings = new OrdersConfig(new ConfigService({}));
    expect(settings.minImages).toBe(1);
    expect(settings.maxImages).toBe(4);
  });

  it('ORDER_MAX_IMAGES=4 se tolera (mismo valor)', () => {
    expect(
      new OrdersConfig(new ConfigService({ ORDER_MAX_IMAGES: ' 4 ' }))
        .maxImages,
    ).toBe(4);
  });

  it.each(['3', '5', '10', 'abc', ''])(
    'ORDER_MAX_IMAGES=%j impide arrancar',
    (value) => {
      expect(
        () => new OrdersConfig(new ConfigService({ ORDER_MAX_IMAGES: value })),
      ).toThrow('ORDER_MAX_IMAGES ya no es configurable');
    },
  );

  it('el minimo configurable no puede superar el maximo fijo', () => {
    expect(
      () => new OrdersConfig(new ConfigService({ ORDER_MIN_IMAGES: '5' })),
    ).toThrow();
    expect(
      new OrdersConfig(new ConfigService({ ORDER_MIN_IMAGES: '4' })).minImages,
    ).toBe(4);
  });
});
