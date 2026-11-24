import type { Prisma } from '../../generated/prisma/client.js';
import type { RoleName } from '../../generated/prisma/enums.js';

type Db = Prisma.TransactionClient;

/** Quien provoco el evento (RF-32: "con fecha, hora y autor"). */
export type TimelineActor =
  | { type: 'USUARIO'; userId: string; role: RoleName | null }
  | { type: 'SISTEMA'; process: string };

/**
 * Evento de la linea de tiempo. `details` es un objeto plano con datos ya
 * aptos para las partes del pedido: la fuente que lo aporta es responsable de
 * NO incluir direccion exacta, contactos ni datos privados (adenda v1.1 §2.2).
 * La linea de tiempo nunca incluye ubicacion en vivo (RF-32 criterio 2).
 */
export interface TimelineEvent {
  /** Unico dentro de su fuente; con `source` forma la identidad del evento. */
  id: string;
  source: string;
  /** Tipo de evento propio de la fuente, por ejemplo "OFERTA_PROPUESTA". */
  type: string;
  at: Date;
  actor: TimelineActor;
  /** Texto breve para mostrar. */
  summary: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Lector PUBLICO que aporta cada modulo propietario de los datos (Orders para
 * el historial de estados, Offers para la negociacion, Payments para pagos,
 * Persona A para visita/ejecucion/reclamo). TimelineModule no lee las tablas
 * de otros modulos (arquitectura §4.2): solo consume lo que ellos exponen.
 */
export interface TimelineSource {
  /** Nombre unico de la fuente. */
  readonly name: string;
  /** Todos los eventos del pedido. Solo lectura, con la transaccion dada. */
  listEvents(db: Db, orderId: string): Promise<TimelineEvent[]>;
}

export interface TimelinePage {
  data: TimelineEvent[];
  /** Cursor de la pagina siguiente; null si no hay mas. */
  nextCursor: string | null;
}
