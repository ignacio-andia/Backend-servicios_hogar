import { NestFactory } from '@nestjs/core';
import { runFirstAdminCli } from './first-admin.cli.js';
import { FirstAdminModule } from './first-admin.module.js';
import { FirstAdministratorService } from './first-admin.service.js';
import { terminalPrompt } from './terminal-prompt.js';

// Comando de ejecucion unica: npm run admin:create-first (ver README).
// No forma parte del servidor: nunca se ejecuta al arrancar la API.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  // Sin terminal interactiva no se puede leer la contrasena sin mostrarla.
  console.error(
    'Este comando requiere una terminal interactiva (PowerShell, CMD o Windows Terminal). No se creó ninguna cuenta.',
  );
  process.exit(1);
}

const context = await NestFactory.createApplicationContext(FirstAdminModule, {
  logger: ['error', 'warn'],
});
let exitCode = 1;
try {
  exitCode = await runFirstAdminCli(
    terminalPrompt,
    context.get(FirstAdministratorService),
    (line) => console.log(line),
  );
} finally {
  await context.close();
}
process.exit(exitCode);
