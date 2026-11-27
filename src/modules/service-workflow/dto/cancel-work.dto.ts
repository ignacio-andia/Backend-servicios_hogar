//=========================================================
// MODIFICADO: cancel-work.dto.ts
// Fase B1 (cancelacion): deja de repetir los validadores del motivo y hereda
// los de CancelOrderDto. La ruta y el contrato de «Cancelar trabajo» no
// cambian.
// Regla (RF-34, CU-34): el motivo es obligatorio, de hasta 500 caracteres.
//=========================================================
import { CancelOrderDto } from '../../orders/dto/cancel-order.dto.js';

/** "Cancelar trabajo" (RF-34): mismas reglas del motivo que cancelar un pedido. */
export class CancelWorkDto extends CancelOrderDto {}
