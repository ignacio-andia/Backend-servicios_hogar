// RF-36: CUANDO se puede reportar la inasistencia. AISLADO a proposito.
//
// PENDIENTE DE CONFIRMAR CON EL DOCENTE: el requerimiento menciona un
// "tiempo de tolerancia" sin definirlo, y la condicion `now >= proposedStartAt`
// tampoco esta confirmada. Hasta que se decida, esta politica NO restringe
// nada: el reporte solo exige un estado valido (NO_SHOW_REPORTABLE_STATUSES).
// Cuando se defina, es el unico lugar a cambiar (y su prueba).

export interface NoShowTimingContext {
  now: Date;
  /** Inicio propuesto de la oferta aceptada (dato disponible para la regla). */
  proposedStartAt: Date;
  estimatedDurationMinutes: number;
}

export function isNoShowReportAllowedAt(
  _context: NoShowTimingContext,
): boolean {
  return true;
}
