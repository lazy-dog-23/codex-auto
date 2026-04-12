export const CLI_EXIT_CODES = {
  unknown: 1,
  usage: 2,
  validation: 3,
  blocked: 4,
} as const;

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = CLI_EXIT_CODES.unknown) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof Error) {
    return new CliError(error.message);
  }

  return new CliError(String(error));
}
