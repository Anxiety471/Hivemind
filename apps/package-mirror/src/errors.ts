/** A request the mirror refuses before it reaches an upstream. */
export class BadRequestError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** An upstream answered badly, or the mirror could not use its answer. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Downloaded bytes did not match the hash the index published. */
export class IntegrityError extends Error {
  readonly status = 502;

  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}
