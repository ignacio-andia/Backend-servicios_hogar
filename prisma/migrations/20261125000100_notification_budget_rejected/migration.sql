-- RF-27 (CU-27 paso 3): aviso al trabajador cuando el cliente rechaza un
-- presupuesto adicional y el trabajo se cierra. Solo agrega un valor al enum.
ALTER TYPE "NotificationType" ADD VALUE 'PRESUPUESTO_ADICIONAL_RECHAZADO';
