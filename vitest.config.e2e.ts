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
  },
});
