import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Las pruebas e2e comparten la base de datos real (por ejemplo, la regla
    // del "único administrador activo"), así que los archivos van en serie.
    fileParallelism: false,
    // Opcional E2E_ISOLATED_SCHEMA=true: corre sobre un esquema temporal.
    globalSetup: ['./test/utils/e2e-schema.global.ts'],
    setupFiles: ['./test/utils/e2e-schema.setup.ts'],
    // Las tareas programadas no corren en e2e: las pruebas las invocan.
    env: { SCHEDULED_JOBS_ENABLED: 'false' },
  },
});
