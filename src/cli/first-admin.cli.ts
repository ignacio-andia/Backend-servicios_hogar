import { ConflictException } from '@nestjs/common';
import {
  FirstAdminInputError,
  FirstAdministratorService,
} from './first-admin.service.js';
import { Prompt, PromptCancelledError } from './terminal-prompt.js';

/**
 * Flujo interactivo del comando: pide los datos, confirma la contrasena y
 * crea el primer administrador. Devuelve el codigo de salida del proceso.
 * Nunca imprime la contrasena ni su hash.
 */
export async function runFirstAdminCli(
  prompt: Prompt,
  service: FirstAdministratorService,
  print: (line: string) => void,
): Promise<number> {
  print('Creación del primer administrador de ArreglaloYA (RF-04).');
  print('Solo funciona si todavía no existe ningún administrador.\n');
  try {
    const firstName = await prompt.ask('Nombre: ');
    const lastName = await prompt.ask('Apellido: ');
    const email = await prompt.ask('Correo electrónico: ');
    const phone = await prompt.ask('Teléfono (opcional, Enter para omitir): ');
    const password = await prompt.askHidden(
      'Contraseña (mínimo 8 caracteres, con letras y números): ',
    );
    const confirmation = await prompt.askHidden('Repita la contraseña: ');
    if (password !== confirmation) {
      print('Error: las contraseñas no coinciden. No se creó ninguna cuenta.');
      return 1;
    }

    const admin = await service.create({
      firstName,
      lastName,
      email,
      password,
      // Vacio o solo espacios: sin telefono (igual que en el registro).
      phone: phone.trim() === '' ? undefined : phone,
    });
    print(`\nAdministrador creado: ${admin.email} (id ${admin.id}).`);
    print('Ya puede iniciar sesión con POST /api/auth/login.');
    return 0;
  } catch (error) {
    if (error instanceof FirstAdminInputError) {
      print('Error: datos inválidos. No se creó ninguna cuenta.');
      for (const problem of error.problems) print(`  - ${problem}`);
    } else if (
      error instanceof ConflictException ||
      error instanceof PromptCancelledError
    ) {
      print(`Error: ${error.message} No se creó ninguna cuenta.`);
    } else {
      print(
        `Error inesperado: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return 1;
  }
}
