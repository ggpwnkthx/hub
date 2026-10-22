import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FIRST_MIGRATION,
  migrationsDirectoryCandidates,
  migrationsDirectoryOf,
  resolveMigrationsDirectory,
} from './migrations'

/** Creates a directory that holds the migrations of the schema. */
async function directoryWithMigrations(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hub-migrations-'))
  const directory = join(root, 'migrations')
  await mkdir(directory)
  await writeFile(join(directory, FIRST_MIGRATION), 'select 1;\n')
  return directory
}

describe('the directory of the migrations of the schema', () => {
  test('the directory next to the module is the first candidate', () => {
    const candidates = migrationsDirectoryCandidates()
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0]).toContain('migrations')
  })

  test('the candidate that holds the migrations is the answer', async () => {
    const directory = await directoryWithMigrations()
    expect(migrationsDirectoryOf([directory])).toBe(directory)
  })

  test('a candidate that holds no migration is refused', async () => {
    const directory = await directoryWithMigrations()
    const empty = await mkdtemp(join(tmpdir(), 'hub-empty-'))
    expect(migrationsDirectoryOf([empty, directory])).toBe(directory)
  })

  test('the first candidate is the answer when none of them holds the migrations', () => {
    expect(migrationsDirectoryOf(['/nowhere/at/all', '/nowhere/either'])).toBe('/nowhere/at/all')
  })

  test('the directory of the running Hub holds the migrations of the schema', async () => {
    // The source tree and the image carry the directory next to the
    // module: the service finds its schema without any configuration.
    const directory = resolveMigrationsDirectory()
    expect(await readFile(join(directory, FIRST_MIGRATION), 'utf8')).toContain('create table')
  })
})
