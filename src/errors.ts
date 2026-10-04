import type { ApiErrorData } from './shared.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Partial<ApiErrorData> = {}) { super(message); }
}
