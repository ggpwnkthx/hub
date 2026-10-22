import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { checkVersionConsistency, checkVersions } from '../../scripts/version'

const root = resolve(import.meta.dir, '..', '..')

describe('the version of the release', () => {
  test('it is the same in every file that holds it', async () => {
    expect(await checkVersions(root)).toEqual([])
  })

  test('a file that holds another version is reported', () => {
    const findings = checkVersionConsistency({
      'package.json': JSON.stringify({ version: '1.2.3' }),
      Dockerfile: 'ARG VERSION=1.2.3\n',
      'docs/spec.md': 'Status: 0.1.0. Runtime: Bun ≥ 1.4.3.\n',
    })
    expect(findings).toEqual([
      {
        file: 'docs/spec.md',
        message: 'the version is "0.1.0" and the package says "1.2.3"',
      },
    ])
  })

  test('a file that holds no version at all is reported', () => {
    const findings = checkVersionConsistency({
      'package.json': JSON.stringify({ version: '1.2.3' }),
      Dockerfile: 'ARG REVISION=unknown\n',
    })
    expect(findings).toEqual([
      { file: 'Dockerfile', message: 'the version 1.2.3 could not be found' },
    ])
  })

  test('the status of the specification is the version of the release', () => {
    const findings = checkVersionConsistency({
      'package.json': JSON.stringify({ version: '1.2.3' }),
      'docs/spec.md': 'Status: 0.3.0. Runtime: Bun ≥ 1.4.3.\n',
    })
    expect(findings).toEqual([
      {
        file: 'docs/spec.md',
        message: 'the version is "0.3.0" and the package says "1.2.3"',
      },
    ])
  })

  test('the state of the release in the documentation is the version of the release', () => {
    const findings = checkVersionConsistency({
      'package.json': JSON.stringify({ version: '1.2.3' }),
      'docs/README.md': 'Version `0.4.0`. The milestones are closed.\n',
    })
    expect(findings).toEqual([
      {
        file: 'docs/README.md',
        message: 'the version is "0.4.0" and the package says "1.2.3"',
      },
    ])
  })

  test('a package without a version is reported', () => {
    const findings = checkVersionConsistency({ 'package.json': JSON.stringify({}) })
    expect(findings).toEqual([
      { file: 'package.json', message: 'the package does not hold a version' },
    ])
  })

  test('a version that is not the version of a release is reported', () => {
    const findings = checkVersionConsistency({
      'package.json': JSON.stringify({ version: '1.0' }),
    })
    expect(findings).toEqual([
      {
        file: 'package.json',
        message: 'the version "1.0" is not the version of a release: three numbers, "1.0.0"',
      },
    ])
  })

  test('a pre-release is not the version of a release', () => {
    const findings = checkVersionConsistency({
      'package.json': JSON.stringify({ version: '1.0.0-rc.1' }),
    })
    expect(findings).toEqual([
      {
        file: 'package.json',
        message: 'the version "1.0.0-rc.1" is not the version of a release: three numbers, "1.0.0"',
      },
    ])
  })
})
