import { QueryFailedError } from 'typeorm';

/** Postgres SQLSTATE codes the API is expected to translate rather than leak. */
export const FOREIGN_KEY_VIOLATION = '23503';
export const UNIQUE_VIOLATION = '23505';
/**
 * Raised when a value exceeds the range of its column type, e.g. int4.
 *
 * Recorded but deliberately not wired into any catch. It is reachable — every
 * `ParseIntPipe`-guarded `:id` route and `POST /orders` will still 500 on an
 * out-of-range id — but those are pre-existing and outside this commit's
 * defects, and the two places that could translate it are both ruled out:
 * a global exception filter is rejected in `docs/README.md`, and the per-call
 * catches here do not wrap the routes that leak. Closing that class properly
 * means bounding every `:id` at its pipe, which is its own change. Written down
 * so the limit is a decision rather than an oversight.
 */
export const NUMERIC_VALUE_OUT_OF_RANGE = '22003';

/**
 * The range an `integer` column accepts. Ids are int4 here, so anything outside
 * this reaches the driver and comes back as an unmapped 500 unless it is
 * rejected at the boundary first. Both ends matter: `@IsInt()` admits negatives.
 */
export const INT4_MAX = 2147483647;
export const INT4_MIN = -2147483648;

interface PostgresDriverError {
  code?: string;
}

/**
 * The SQLSTATE behind a TypeORM failure, or undefined if it was not a driver
 * error. Constraint violations are how Postgres reports a broken business rule,
 * and without this they reach the client as a bare 500 carrying the raw
 * constraint name.
 */
export function sqlState(error: unknown): string | undefined {
  if (error instanceof QueryFailedError) {
    return (error.driverError as PostgresDriverError | undefined)?.code;
  }
  return undefined;
}
