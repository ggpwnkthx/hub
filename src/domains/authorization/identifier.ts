/**
 * The identifiers of the platform (spec §8.1).
 *
 * The id of a principal and the id of a tenant are uuids: the rows of
 * the tables are created by the database and the contracts carry those
 * ids. A value that is not one names no row, and the contract answers a
 * refusal of the request and not a failure of the storage: the database
 * is never asked to cast a value it cannot cast.
 */

/**
 * The shape of a uuid, as PostgreSQL accepts it.
 *
 * The shape is the one of the database and not the one of a version: the
 * database accepts any uuid it can store, and the contracts do not
 * refuse an id that the database would have accepted.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Reports whether a value is the id of a row of the platform.
 *
 * The answer is false for the empty string and for every value that is
 * not a uuid.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}
