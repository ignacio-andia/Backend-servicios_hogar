import { createInterface } from 'node:readline/promises';

export interface Prompt {
  /** Pregunta visible (el texto escrito se ve en pantalla). */
  ask(question: string): Promise<string>;
  /** Pregunta oculta: lo que se escribe no se muestra ni queda en pantalla. */
  askHidden(question: string): Promise<string>;
}

export class PromptCancelledError extends Error {
  constructor() {
    super('Operación cancelada por el usuario.');
    this.name = 'PromptCancelledError';
  }
}

const ENTER = new Set(['\r', '\n']);
const CTRL_C = '\u0003';
const BACKSPACE = new Set(['\u007f', '\b']);

/**
 * Prompt de la consola. La contrasena se lee en modo crudo, sin eco: exige
 * una terminal interactiva (PowerShell, CMD o Windows Terminal). Nunca se
 * acepta por argumentos ni variables de entorno, para que no quede en el
 * historial de comandos.
 */
export const terminalPrompt: Prompt = {
  async ask(question) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },

  askHidden(question) {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      return Promise.reject(
        new Error(
          'La contraseña solo se puede escribir en una terminal interactiva (PowerShell, CMD o Windows Terminal).',
        ),
      );
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    return new Promise((resolve, reject) => {
      let value = '';
      const finish = (error?: Error) => {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (ENTER.has(char)) return finish();
          if (char === CTRL_C) return finish(new PromptCancelledError());
          if (BACKSPACE.has(char)) value = value.slice(0, -1);
          else if (char >= ' ') value += char;
        }
      };
      stdin.on('data', onData);
    });
  },
};
