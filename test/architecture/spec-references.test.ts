import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..')

/**
 * The references to the specification (spec §N).
 *
 * The specification is the normative document of Hub, and the code, the
 * tests and the other documents point at it by its number. A reference
 * that points at nothing is a dead end for the reader and a lie about
 * the contract: the number of a section that moved is the number of a
 * rule that is somewhere else.
 *
 * The test reads the headings of the specification and checks that every
 * reference of the repository resolves to one of them.
 */

/** A reference to a section of the specification. */
interface Reference {
  /** The file the reference is in. */
  file: string
  /** The line the reference is on. */
  line: number
  /** The number that is referenced, "9" or "10.12". */
  number: string
}

/** The directories the references are read from. */
const DIRECTORIES = ['src', 'test', 'scripts', 'docs']

/** The files of the root that are read. */
const ROOT_FILES = ['README.md', 'CHANGELOG.md']

/** The headings of the specification: the numbers that exist. */
async function sectionsOfSpecification(): Promise<Set<string>> {
  const content = await readFile(join(root, 'docs', 'spec.md'), 'utf8')
  const sections = new Set<string>()
  for (const line of content.split('\n')) {
    // A heading of the specification: "## 9.", "### 10.6" and
    // "### 4.3.1" are all sections that a reference may name.
    const heading = /^#{2,4} (\d+(?:\.\d+)*)\.? /.exec(line)
    if (heading) sections.add(heading[1]!)
  }
  return sections
}

/** The files of a directory, recursively. */
async function filesOf(directory: string): Promise<string[]> {
  const found: string[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await filesOf(path)))
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.md')) found.push(path)
  }
  return found
}

/** Every reference of the repository. */
async function referencesOf(): Promise<Reference[]> {
  const files: string[] = []
  for (const directory of DIRECTORIES) files.push(...(await filesOf(join(root, directory))))
  for (const file of ROOT_FILES) {
    // A file of the root that is not there is not a broken reference:
    // it is a file that this tree does not carry.
    const path = join(root, file)
    if (existsSync(path)) files.push(path)
  }

  const references: Reference[] = []
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      // The reference of a section: "§9" or "§10.12". A trailing dot is
      // the punctuation of the sentence.
      for (const match of line.matchAll(/§(\d+(?:\.\d+)*)\.?(?![0-9])/g)) {
        references.push({
          file: relative(root, file),
          line: index + 1,
          number: match[1]!,
        })
      }
    }
  }
  return references
}

describe('the references to the specification', () => {
  test('every reference points at a section of the specification', async () => {
    const sections = await sectionsOfSpecification()
    const references = await referencesOf()
    const findings: string[] = []
    for (const reference of references) {
      // A reference to a section that exists, or to a subsection that
      // exists: "10.12" is known when it is a heading of the
      // specification. A subsection that does not exist is a dead end,
      // even when the section that holds it exists.
      const known = sections.has(reference.number)
      if (!known) {
        findings.push(
          `${reference.file}:${reference.line} refers to §${reference.number}, which is not a section of the specification`
        )
      }
    }
    expect(findings).toEqual([])
  })

  test('the specification holds the sections the code refers to', async () => {
    // The sections that the code names the most: they are the contract
    // of the service, and they have to be there.
    const sections = await sectionsOfSpecification()
    for (const number of ['3.9', '5.2', '8.8', '9', '10.1', '14']) {
      expect(sections.has(number)).toBe(true)
    }
  })
})
