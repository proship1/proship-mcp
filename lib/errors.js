// Shared error class for upstream ProShip calls.
//
// The client throws `ShippingError` (with optional `code`, `status`,
// `body`) so callers can branch on `e instanceof ShippingError`.

export class ShippingError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message);
    this.name = 'ShippingError';
    this.code = code || 'UNKNOWN';
    this.status = status;
    this.body = body;
  }
}
