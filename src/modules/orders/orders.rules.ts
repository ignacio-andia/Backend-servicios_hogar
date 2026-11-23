import { OrderStatus } from '../../generated/prisma/enums.js';

// Reglas centrales de OrdersModule. Las marcadas como PENDIENTE DE CONFIRMAR
// CON EL DOCENTE no deben cambiarse sin esa confirmacion.

// Descripcion del problema (decision del equipo). Son constantes porque los
// decoradores de validacion se evaluan antes de cargar la configuracion.
export const ORDER_DESCRIPTION_MIN_LENGTH = 10;
export const ORDER_DESCRIPTION_MAX_LENGTH = 2000;
export const ORDER_ADDRESS_MAX_LENGTH = 255;
// Igual que la columna order_status_history.reason.
export const ORDER_STATUS_REASON_MAX_LENGTH = 500;

// Maximo de fotografias por pedido: regla de negocio confirmada (T5.3), no
// configurable. La variable ORDER_MAX_IMAGES ya no existe: si se define con
// otro valor, la aplicacion no arranca (OrdersConfig).
export const ORDER_MAX_IMAGES = 4;

// Tope tecnico absoluto: la configuracion no puede superarlo.
export const ABSOLUTE_IMAGE_MAX_MB = 25;

/**
 * Estados en los que el cliente puede editar o cancelar (CU-18: "Publicado o
 * En negociacion"). Con acuerdo se usa "Cancelar trabajo" (RF-34).
 * PENDIENTE DE CONFIRMAR CON EL DOCENTE: si editar en negociacion mantiene
 * validas las ofertas existentes (lo resolvera el modulo de ofertas).
 */
export const ORDER_EDITABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PUBLICADO,
  OrderStatus.EN_NEGOCIACION,
];
export const ORDER_CANCELLABLE_STATUSES = ORDER_EDITABLE_STATUSES;

/** Estados en los que un trabajador habilitado puede ver el pedido (RF-17, CU-19). */
export const ORDER_WORKER_VISIBLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PUBLICADO,
  OrderStatus.EN_NEGOCIACION,
];

/**
 * Plazo de vigencia de un pedido (especificacion v1.0 §3 y adenda v1.1 §2.3,
 * T5.1): 7 dias calendario desde la publicacion original. Se fija una sola vez
 * al crear el pedido (expires_at = published_at + 7 dias, con el reloj de la
 * BD) y nunca se reinicia: ni al editar, ni al cambiar de estado, ni al volver
 * a PUBLICADO despues de una negociacion fallida. No depende de las ofertas.
 */
export const ORDER_EXPIRATION_DAYS = 7;

/**
 * Estados que vencen al cumplirse el plazo (T5.1): tambien EN_NEGOCIACION.
 * Con acuerdo (ACORDADO en adelante) el pedido ya no vence.
 */
export const ORDER_EXPIRABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PUBLICADO,
  OrderStatus.EN_NEGOCIACION,
];

/**
 * Estados que cuentan como pedido activo (duplicados, trabajo activo del
 * trabajador). PENDIENTE DE CONFIRMAR CON EL DOCENTE: clasificacion inicial.
 */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PUBLICADO,
  OrderStatus.EN_NEGOCIACION,
  OrderStatus.ACORDADO,
  OrderStatus.ANTICIPO_REGISTRADO,
  OrderStatus.VISITA_REALIZADA,
  OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
  OrderStatus.EN_EJECUCION,
  OrderStatus.TERMINADO,
  OrderStatus.EN_RECLAMO,
];

/** Estados con acuerdo: no se editan; se usa "Cancelar trabajo" (RF-34). */
const AGREED_STATUSES = [
  OrderStatus.ACORDADO,
  OrderStatus.ANTICIPO_REGISTRADO,
  OrderStatus.VISITA_REALIZADA,
  OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
  OrderStatus.EN_EJECUCION,
  OrderStatus.TERMINADO,
  OrderStatus.EN_RECLAMO,
] as const;
export type OrderAgreedStatus = (typeof AGREED_STATUSES)[number];
export const ORDER_AGREED_STATUSES: readonly OrderStatus[] = AGREED_STATUSES;

/**
 * Transiciones permitidas. Cada modulo (ofertas, pagos, visitas, agenda,
 * reclamos) agrega aqui las suyas al integrarse y las ejecuta con
 * OrdersService.transition(). CANCELADO y VENCIDO tienen efectos propios
 * (fotos, hooks): solo se llega a ellos con OrdersService.cancel() y
 * OrderExpirationService.
 *
 * Transiciones de ofertas (decision del equipo):
 * - PUBLICADO -> EN_NEGOCIACION: al recibir la primera oferta.
 * - EN_NEGOCIACION -> ACORDADO: al aceptar una oferta; asigna el trabajador.
 * - EN_NEGOCIACION -> PUBLICADO: sin ofertas vigentes; conserva el
 *   vencimiento original (T5.1).
 * - PUBLICADO o EN_NEGOCIACION -> VENCIDO: al cumplirse el plazo (T5.1), solo
 *   por OrderExpirationService.
 * PENDIENTE DE CONFIRMAR CON EL DOCENTE (no se agregan): cuando se llega a
 * SIN_ACUERDO y como se sale de ACORDADO (RF-34).
 */
export const ORDER_TRANSITIONS: Readonly<
  Partial<Record<OrderStatus, readonly OrderStatus[]>>
> = {
  [OrderStatus.PUBLICADO]: [
    OrderStatus.EN_NEGOCIACION,
    OrderStatus.CANCELADO,
    OrderStatus.VENCIDO,
  ],
  [OrderStatus.EN_NEGOCIACION]: [
    OrderStatus.ACORDADO,
    OrderStatus.PUBLICADO,
    OrderStatus.CANCELADO,
    OrderStatus.VENCIDO,
  ],
};

/**
 * Estados que exigen un trabajador asignado: con acuerdo. El trabajador se
 * asigna al entrar a ACORDADO, en la misma operacion que el cambio de estado.
 */
export const ORDER_WORKER_REQUIRED_STATUSES = ORDER_AGREED_STATUSES;

/** Unico destino que asigna al trabajador: aceptar una oferta. */
export const ORDER_ASSIGNMENT_TARGET = OrderStatus.ACORDADO;
export type OrderAssignmentTarget = typeof ORDER_ASSIGNMENT_TARGET;

/** Destinos que solo alcanza OrdersModule (ver ORDER_TRANSITIONS). */
const INTERNAL_TARGETS = [OrderStatus.CANCELADO, OrderStatus.VENCIDO] as const;
export type OrderInternalTarget = (typeof INTERNAL_TARGETS)[number];
export const ORDER_INTERNAL_TARGETS: readonly OrderStatus[] = INTERNAL_TARGETS;

/** Estados en los que un trabajador puede ofertar (para el modulo de ofertas). */
export const ORDER_OPEN_FOR_OFFERS_STATUSES = ORDER_WORKER_VISIBLE_STATUSES;

// Proceso del sistema que registra el vencimiento en el historial.
export const EXPIRATION_PROCESS = 'VENCIMIENTO';
