import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { OrdersConfig } from '../orders.config.js';
import {
  OrderImageProcessor,
  UploadedImageFile,
} from './order-image.processor.js';

const asFile = (
  buffer: Buffer,
  originalname = 'foto.jpg',
): UploadedImageFile => ({
  buffer,
  size: buffer.length,
  originalname,
  mimetype: 'image/jpeg',
});

const solid = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 60, b: 30 },
    },
  });

const processorWith = (env: Record<string, string> = {}) =>
  new OrderImageProcessor(new OrdersConfig(new ConfigService(env)));

describe('OrderImageProcessor', () => {
  const processor = processorWith();

  it('elimina EXIF, GPS, XMP y el perfil ICC, y entrega WebP en sRGB', async () => {
    const input = await solid(640, 480)
      .jpeg()
      .withExif({
        IFD0: { Copyright: 'Juan Perez', Artist: 'Juan Perez' },
        IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '17/1 23/1 0/1' },
      })
      .withXmp(
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>',
      )
      .withIccProfile('p3')
      .toBuffer();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(before.xmp).toBeDefined();
    expect(before.icc).toBeDefined();

    const result = await processor.process(asFile(input));

    for (const output of [result.content, result.thumbnail]) {
      const meta = await sharp(output).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
      expect(meta.space).toBe('srgb');
    }
    expect(result.mimeType).toBe('image/webp');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('corrige la orientacion antes de quitar los metadatos', async () => {
    // 200x100 con orientacion EXIF 6 (rotar 90°): se debe ver vertical.
    const input = await solid(200, 100)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await processor.process(asFile(input));

    expect([result.width, result.height]).toEqual([100, 200]);
    expect(
      (await sharp(result.content).metadata()).orientation,
    ).toBeUndefined();
  });

  it('reduce al lado maximo de 1600 px y genera la miniatura de 400 px', async () => {
    const input = await solid(3000, 2000).png().toBuffer();

    const result = await processor.process(asFile(input, 'grande.png'));

    expect([result.width, result.height]).toEqual([1600, 1067]);
    const thumb = await sharp(result.thumbnail).metadata();
    expect(Math.max(thumb.width, thumb.height)).toBe(400);
    expect(result.sizeBytes).toBe(result.content.length);
    expect(result.thumbnailSizeBytes).toBeLessThan(result.sizeBytes);
  });

  it('no agranda imagenes pequenas', async () => {
    const input = await solid(300, 200).webp().toBuffer();

    const result = await processor.process(asFile(input, 'chica.webp'));

    expect([result.width, result.height]).toEqual([300, 200]);
  });

  it('acepta JPG, PNG y WebP segun su contenido real', async () => {
    for (const encoder of ['jpeg', 'png', 'webp'] as const) {
      const input = await solid(50, 50)[encoder]().toBuffer();
      await expect(
        processor.process(asFile(input, 'x.bin')),
      ).resolves.toBeDefined();
    }
  });

  it('rechaza formatos no permitidos aunque la extension diga JPG', async () => {
    const gif = await solid(50, 50).gif().toBuffer();
    await expect(processor.process(asFile(gif, 'foto.jpg'))).rejects.toThrow(
      'Formato de imagen no permitido. Formatos aceptados: JPG, PNG, WebP',
    );
  });

  it('rechaza archivos que no son imagenes o estan danados', async () => {
    await expect(
      processor.process(
        asFile(Buffer.from('MZ esto no es una imagen'), 'foto.jpg'),
      ),
    ).rejects.toThrow('El archivo no es una imagen válida o está dañado');

    const jpeg = await solid(200, 200).jpeg().toBuffer();
    await expect(
      processor.process(asFile(jpeg.subarray(0, jpeg.length / 2))),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza imagenes que superan el limite de megapixeles', async () => {
    const limited = processorWith({ ORDER_IMAGE_MAX_PIXELS: '10000' });
    const input = await solid(200, 200).jpeg().toBuffer();

    await expect(limited.process(asFile(input))).rejects.toThrow(
      'La imagen supera el máximo de 0 megapíxeles',
    );
  });

  it('rechaza archivos vacios o mas pesados que el limite configurado', async () => {
    await expect(processor.process(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const input = await solid(50, 50).png().toBuffer();
    const tooBig = { ...asFile(input), size: 11 * 1024 * 1024 };
    await expect(processor.process(tooBig)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
  });
});
