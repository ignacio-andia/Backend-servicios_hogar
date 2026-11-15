import type { OrderWarning } from './order-views.js';

/**
 * Similitud minima (indice de Jaccard sobre palabras) para avisar un posible
 * duplicado. Alta a proposito para evitar falsos positivos: la deteccion es
 * orientativa y nunca bloquea (decision del equipo).
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

// Palabras demasiado comunes para distinguir un pedido de otro.
const STOPWORDS = new Set([
  'que',
  'con',
  'por',
  'para',
  'los',
  'las',
  'del',
  'una',
  'uno',
  'unos',
  'unas',
  'muy',
  'mas',
  'pero',
  'como',
  'esta',
  'este',
  'estos',
  'estas',
  'eso',
  'esa',
  'ese',
  'tengo',
  'tiene',
  'hay',
  'mi',
  'mis',
  'sus',
  'favor',
  'necesito',
  'quiero',
  'desde',
  'hace',
  'cuando',
  'donde',
  'sin',
  'sobre',
]);

export function toTokens(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

/** Indice de Jaccard entre dos textos (0: nada en comun, 1: mismas palabras). */
export function textSimilarity(a: string, b: string): number {
  const left = toTokens(a);
  const right = toTokens(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
}

export function duplicateWarning(orderIds: string[]): OrderWarning | null {
  return orderIds.length > 0
    ? {
        code: 'POSIBLE_DUPLICADO',
        message:
          'Ya tiene un pedido activo muy parecido en la misma categoría y zona. Revíselo antes de publicar otro; puede continuar si es un trabajo distinto.',
        orderIds,
      }
    : null;
}

// Telefono (7 o mas digitos, con o sin separadores) o correo electronico.
const PHONE_PATTERN = /(?:\+?\d[\s.-]?){7,}/;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Los trabajadores ven la descripcion: si parece contener un telefono o un
 * correo, se avisa al cliente. No bloquea la publicacion (decision del equipo).
 */
export function personalDataWarning(description: string): OrderWarning | null {
  return PHONE_PATTERN.test(description) || EMAIL_PATTERN.test(description)
    ? {
        code: 'POSIBLE_DATO_PERSONAL',
        message:
          'La descripción parece incluir un teléfono o un correo. Los trabajadores la verán antes de que exista un acuerdo; le sugerimos quitar sus datos personales.',
      }
    : null;
}
