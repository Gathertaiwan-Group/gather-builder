export type ServiceErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict"
  | "confirm_required"
  | "rate_limited";

export class ServiceError extends Error {
  constructor(
    public code: ServiceErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
