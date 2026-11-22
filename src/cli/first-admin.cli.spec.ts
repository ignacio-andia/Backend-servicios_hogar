import { ConflictException } from '@nestjs/common';
import { RoleName, UserStatus } from '../generated/prisma/enums.js';
import { runFirstAdminCli } from './first-admin.cli.js';
import {
  FirstAdminInputError,
  FirstAdministratorService,
} from './first-admin.service.js';
import { Prompt, PromptCancelledError } from './terminal-prompt.js';

const ADMIN = {
  id: '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f',
  firstName: 'Ada',
  lastName: 'Admin',
  email: 'ada@example.com',
  phone: null,
  status: UserStatus.ACTIVO,
  roles: [RoleName.ADMINISTRADOR],
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Prompt falso: responde en orden y registra que preguntas fueron ocultas. */
const fakePrompt = (visible: string[], hidden: string[]) => {
  const hiddenQuestions: string[] = [];
  const prompt: Prompt = {
    ask: vi.fn(() => Promise.resolve(visible.shift() ?? '')),
    askHidden: vi.fn((question: string) => {
      hiddenQuestions.push(question);
      return Promise.resolve(hidden.shift() ?? '');
    }),
  };
  return { prompt, hiddenQuestions };
};

describe('runFirstAdminCli', () => {
  let create: ReturnType<typeof vi.fn>;
  let service: FirstAdministratorService;
  let lines: string[];
  const print = (line: string) => lines.push(line);

  beforeEach(() => {
    create = vi.fn().mockResolvedValue(ADMIN);
    service = { create } as unknown as FirstAdministratorService;
    lines = [];
  });

  it('pide la contraseña oculta dos veces y crea el administrador', async () => {
    const { prompt, hiddenQuestions } = fakePrompt(
      ['Ada', 'Admin', 'ada@example.com', ''],
      ['Clave1234', 'Clave1234'],
    );

    expect(await runFirstAdminCli(prompt, service, print)).toBe(0);

    expect(hiddenQuestions).toHaveLength(2);
    expect(create).toHaveBeenCalledWith({
      firstName: 'Ada',
      lastName: 'Admin',
      email: 'ada@example.com',
      password: 'Clave1234',
      phone: undefined,
    });
    const output = lines.join('\n');
    expect(output).toContain('Administrador creado: ada@example.com');
    expect(output).not.toContain('Clave1234');
  });

  it('no crea nada si las contraseñas no coinciden', async () => {
    const { prompt } = fakePrompt(
      ['Ada', 'Admin', 'ada@example.com', ''],
      ['Clave1234', 'Otra1234'],
    );

    expect(await runFirstAdminCli(prompt, service, print)).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('no coinciden');
  });

  it.each([
    ['datos inválidos', new FirstAdminInputError(['email must be an email'])],
    [
      'administrador existente',
      new ConflictException('Ya existe un administrador.'),
    ],
    ['cancelación', new PromptCancelledError()],
  ])('informa el error (%s) y termina con código 1', async (_label, error) => {
    create.mockRejectedValue(error);
    const { prompt } = fakePrompt(
      ['Ada', 'Admin', 'ada@example.com', '70000000'],
      ['Clave1234', 'Clave1234'],
    );

    expect(await runFirstAdminCli(prompt, service, print)).toBe(1);
    const output = lines.join('\n');
    expect(output).toContain('No se creó ninguna cuenta');
    expect(output).not.toContain('Clave1234');
  });
});
