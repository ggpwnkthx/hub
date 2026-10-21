/**
 * The factory of the database.
 *
 * The driver is chosen by the environment and not by the code: a
 * deployment talks to a PostgreSQL server and a development machine runs
 * the embedded PostgreSQL of the process. Both are PostgreSQL, so the
 * migrations of the production are the migrations of the development.
 */

import type { Database, DatabaseOptions } from './database'

/**
 * Opens the database of the service.
 *
 * The drivers are loaded on demand: the image of a deployment does not
 * carry the embedded one, and the development machine does not load the
 * client of a server it does not use.
 */
export async function createDatabase(options: DatabaseOptions): Promise<Database> {
  if (options.driver === 'pglite') {
    const { createPgliteDatabase } = await import('./pglite')
    return await createPgliteDatabase(options.path ?? '')
  }
  if (!options.url) {
    throw new Error('the url of the PostgreSQL server is missing')
  }
  const { createPostgresDatabase } = await import('./postgres')
  return createPostgresDatabase({ url: options.url, schema: options.schema })
}
