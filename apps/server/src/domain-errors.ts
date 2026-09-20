/** Failures that callers can handle without depending on HTTP response semantics. */
export type DomainErrorKind =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "access_denied"
  | "authentication_required"
  | "sync_position_expired"
  | "integrity_failure"
  | "group_direct_client_upgrade_required";

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
