# ReportsModule: reportes administrativos (RF-52)

`GET /api/admin/reports/:type?from=AAAA-MM-DD&to=AAAA-MM-DD&format=json|csv`,
solo administradores. Tipos: `pedidos`, `trabajadores`, `calificaciones`,
`cancelaciones` y `reclamos`. Contrato completo en el
[documento 10](../../../docs/frontend-api-contracts/10-sprint1-endpoints.md).

- Solo lectura. Cada módulo entrega sus registros sin datos personales
  (`listForReport`) y aquí se agrupan y cuentan (`report-format.ts`).
- El rango incluye ambos días en hora de Bolivia (`America/La_Paz`, UTC-4).
- El CSV lleva marca UTF-8 y neutraliza los textos que empiezan como fórmula.
- Decisiones técnicas: la fecha que cuenta en cada tipo se informa en `basis`;
  `trabajadores` y `reclamos` muestran el estado **actual** de lo creado en el
  rango; `pedidos` usa el estado almacenado.
- Los reportes se calculan en memoria: adecuado para el volumen actual, no para
  millones de registros.
