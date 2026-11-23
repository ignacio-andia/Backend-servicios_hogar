// T6.6: enlace de WhatsApp entre cliente y trabajador. WhatsApp es solo un
// canal externo: abrir el enlace no envia nada ni cambia la oferta.

/**
 * Codigo de pais por defecto para telefonos guardados sin "+". El proyecto
 * opera en Bolivia (zonas de Cochabamba, hora de America/La_Paz) y el
 * registro acepta numeros locales (PHONE_PATTERN tiene el "+" opcional).
 */
export const DEFAULT_COUNTRY_CODE = '591';
// Celular boliviano local: 8 digitos que empiezan con 6 o 7.
const LOCAL_MOBILE = /^[67]\d{7}$/;
// Formato internacional (E.164): de 8 a 15 digitos, sin cero inicial.
const INTERNATIONAL = /^[1-9]\d{7,14}$/;

export const WHATSAPP_BASE_URL = 'https://wa.me/';

export type ContactUnavailableReason =
  'TELEFONO_NO_REGISTRADO' | 'TELEFONO_INVALIDO';

/**
 * Respuesta controlada: si no hay un numero valido no se arma un enlace
 * defectuoso; `available: false` permite ocultar o deshabilitar el boton.
 * Nunca incluye el telefono por separado: solo va dentro del enlace.
 */
export type WhatsAppContact =
  | {
      available: true;
      channel: 'WHATSAPP';
      contactRole: 'CLIENTE' | 'TRABAJADOR';
      url: string;
    }
  | {
      available: false;
      channel: 'WHATSAPP';
      contactRole: 'CLIENTE' | 'TRABAJADOR';
      url: null;
      reason: ContactUnavailableReason;
    };

/**
 * Numero para wa.me: solo digitos y con codigo de pais, sin "+", espacios,
 * parentesis ni guiones.
 * - Con "+": se toma como internacional.
 * - Sin "+": un celular local (8 digitos, 6 o 7 al inicio) recibe el codigo
 *   de Bolivia; uno que ya empieza con 591 y tiene 11 digitos se acepta.
 * - Cualquier otro caso (fijos, longitudes raras, letras) es invalido.
 */
export function toWhatsAppNumber(
  phone: string | null | undefined,
): string | null {
  if (phone === null || phone === undefined || phone.trim() === '') {
    return null;
  }
  const raw = phone.trim();
  const international = raw.startsWith('+') || raw.startsWith('00');
  const digits = raw.replace(/[\s().-]/g, '').replace(/^(\+|00)/, '');
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  if (international) {
    return INTERNATIONAL.test(digits) ? digits : null;
  }
  if (LOCAL_MOBILE.test(digits)) {
    return `${DEFAULT_COUNTRY_CODE}${digits}`;
  }
  if (digits.startsWith(DEFAULT_COUNTRY_CODE) && digits.length === 11) {
    return LOCAL_MOBILE.test(digits.slice(3)) ? digits : null;
  }
  return null;
}

/** Referencia publica y corta del pedido (sin datos personales). */
export function orderReference(orderId: string): string {
  return orderId.replace(/-/g, '').slice(0, 8).toUpperCase();
}

/**
 * Mensaje inicial breve: identifica el pedido por su referencia. Nunca lleva
 * direccion, documentos, montos ni nombres.
 */
export function contactMessage(
  contactRole: 'CLIENTE' | 'TRABAJADOR',
  orderId: string,
): string {
  const ref = orderReference(orderId);
  return contactRole === 'TRABAJADOR'
    ? `Hola, te escribo por tu oferta para mi pedido ${ref} en ArreglaloYA.`
    : `Hola, te escribo por mi oferta para tu pedido ${ref} en ArreglaloYA.`;
}

export function buildWhatsAppContact(
  phone: string | null | undefined,
  contactRole: 'CLIENTE' | 'TRABAJADOR',
  orderId: string,
): WhatsAppContact {
  const base = { channel: 'WHATSAPP' as const, contactRole };
  if (phone === null || phone === undefined || phone.trim() === '') {
    return {
      ...base,
      available: false,
      url: null,
      reason: 'TELEFONO_NO_REGISTRADO',
    };
  }
  const number = toWhatsAppNumber(phone);
  if (!number) {
    return {
      ...base,
      available: false,
      url: null,
      reason: 'TELEFONO_INVALIDO',
    };
  }
  const text = encodeURIComponent(contactMessage(contactRole, orderId));
  return {
    ...base,
    available: true,
    url: `${WHATSAPP_BASE_URL}${number}?text=${text}`,
  };
}
