import {
  DUPLICATE_SIMILARITY_THRESHOLD,
  duplicateWarning,
  personalDataWarning,
  textSimilarity,
  toTokens,
} from './order-warnings.js';

describe('order-warnings', () => {
  it('normaliza tildes, mayusculas y palabras comunes', () => {
    expect([
      ...toTokens('Tengo una FUGA de agua en el baño, por favor'),
    ]).toEqual(['fuga', 'agua', 'bano']);
  });

  it('textos casi iguales superan el umbral de duplicado', () => {
    const a = 'Fuga de agua debajo del lavaplatos de la cocina';
    const b = 'fuga de agua debajo del lavaplatos de la cocina!';
    expect(textSimilarity(a, b)).toBeGreaterThanOrEqual(
      DUPLICATE_SIMILARITY_THRESHOLD,
    );
  });

  it('trabajos distintos de la misma categoria no se marcan como duplicados', () => {
    const a = 'Fuga de agua debajo del lavaplatos de la cocina';
    const b = 'Instalar una ducha electrica nueva en el segundo baño';
    expect(textSimilarity(a, b)).toBeLessThan(DUPLICATE_SIMILARITY_THRESHOLD);
    expect(
      textSimilarity(
        'Cambiar el grifo de la cocina que gotea',
        'Cambiar el grifo del baño que gotea mucho',
      ),
    ).toBeLessThan(DUPLICATE_SIMILARITY_THRESHOLD);
  });

  it('sin palabras significativas la similitud es 0', () => {
    expect(textSimilarity('que con por', 'que con por')).toBe(0);
  });

  it('la advertencia de duplicado solo aparece si hay pedidos parecidos', () => {
    expect(duplicateWarning([])).toBeNull();
    expect(duplicateWarning(['a'])).toMatchObject({
      code: 'POSIBLE_DUPLICADO',
      orderIds: ['a'],
    });
  });

  it.each([
    'Llámeme al 71234567 para coordinar',
    'Mi celular es +591 712-34-567',
    'Escriban a juan.perez@gmail.com',
  ])('advierte posibles datos personales: %s', (text) => {
    expect(personalDataWarning(text)).toMatchObject({
      code: 'POSIBLE_DATO_PERSONAL',
    });
  });

  it('no advierte en descripciones sin telefono ni correo', () => {
    expect(
      personalDataWarning('Se rompio la cañeria del patio, son 3 metros'),
    ).toBeNull();
  });
});
