import { ConfigService } from '@nestjs/config';
import {
  CLAIM_IMAGES_TECHNICAL_CEILING,
  ClaimsConfig,
} from './claims.config.js';

const config = (values: Record<string, string>) => new ConfigService(values);

describe('ClaimsConfig (fotos del reclamo, RF-37)', () => {
  it('por defecto no impone minimo (0) ni un maximo de negocio (solo el tope tecnico)', () => {
    const settings = new ClaimsConfig(config({}));
    expect(settings.minImages).toBe(0);
    expect(settings.maxImages).toBe(CLAIM_IMAGES_TECHNICAL_CEILING);
  });

  it('el minimo y el maximo son configurables', () => {
    const settings = new ClaimsConfig(
      config({ CLAIM_MIN_IMAGES: '1', CLAIM_MAX_IMAGES: '6' }),
    );
    expect([settings.minImages, settings.maxImages]).toEqual([1, 6]);
  });

  it.each([
    [{ CLAIM_MIN_IMAGES: '3', CLAIM_MAX_IMAGES: '2' }],
    [{ CLAIM_MAX_IMAGES: '0' }],
    [{ CLAIM_MAX_IMAGES: '21' }],
    [{ CLAIM_MIN_IMAGES: '-1' }],
    [{ CLAIM_MIN_IMAGES: 'abc' }],
  ])('un valor invalido detiene el arranque %j', (values) => {
    expect(() => new ClaimsConfig(config(values))).toThrow();
  });
});
