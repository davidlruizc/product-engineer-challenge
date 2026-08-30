import { QueryFailedError } from 'typeorm';

/** Postgres SQLSTATE codes the API is expected to translate rather than leak. */
export const FOREIGN_KEY_VIOLATION = '23503';
export const UNIQUE_VIOLATION = '23505';
/** Raised when a value exceeds the range of its column type, e.g. int4. */
export const NUMERIC_VALUE_OUT_OF_RANGE = '22003';

/**
 * The largest value an `integer` column accepts. Ids are int4 here, so anything
 * past this reaches the driver and comes back as an unmapped 500 unless it is
 * rejected at the boundary first.
 */
export const INT4_MAX = 2147483647;

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
