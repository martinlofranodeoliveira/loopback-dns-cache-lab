export type ErrorCode = 'InvalidArgument' | 'ClockRegression' | 'Busy' | 'DeadlineExceeded' | 'DecodeError' | 'ProtocolError' | 'LimitExceeded' | 'NetworkError';

export class LabError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'LabError';
  }
}

export function asLabError(error: unknown): LabError {
  return error instanceof LabError ? error : new LabError('NetworkError', 'Local socket operation failed');
}

export function integer(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new LabError('InvalidArgument', `${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
