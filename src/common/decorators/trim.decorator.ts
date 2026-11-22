import { Transform } from 'class-transformer';

export const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * Como Trim, pero una cadena vacia (o solo con espacios) se convierte en
 * `emptyValue`: `undefined` la trata como un campo ausente y `null` como un
 * pedido explicito de borrar el dato. Pensado para campos opcionales que los
 * formularios envian como "" cuando el usuario no los completa. Los valores
 * que no son cadenas no se modifican: las validaciones siguen aplicandose.
 */
export const TrimEmptyAs = (emptyValue: null | undefined): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed = value.trim();
    return trimmed === '' ? emptyValue : trimmed;
  });
