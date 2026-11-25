import { Injectable } from '@nestjs/common';
import type { TimelineSource } from './timeline.types.js';

/**
 * Punto de integracion de la linea de tiempo (mismo patron que
 * OrderLifecycleRegistry): cada modulo propietario registra su lector, por
 * ejemplo en onModuleInit, y TimelineModule nunca los importa. Asi no hay
 * dependencias circulares ni lecturas directas de tablas ajenas.
 */
@Injectable()
export class TimelineSourceRegistry {
  private readonly sources = new Map<string, TimelineSource>();

  register(source: TimelineSource): void {
    if (this.sources.has(source.name)) {
      throw new Error(`Ya hay una fuente de linea de tiempo ${source.name}`);
    }
    this.sources.set(source.name, source);
  }

  list(): TimelineSource[] {
    return [...this.sources.values()];
  }
}
