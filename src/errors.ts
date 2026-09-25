export class DeliveryError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'DeliveryError';
    this.hint = hint;
  }
}
