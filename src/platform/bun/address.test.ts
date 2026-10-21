import { describe, expect, test } from 'bun:test'
import { assertCallableAddress, isPrivateAddress } from './address'

describe('the addresses of the providers', () => {
  test('the private addresses are known', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('192.168.1.1')).toBe(true)
    expect(isPrivateAddress('169.254.1.1')).toBe(true)
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
  })

  test('an address that resolves to a private one is refused', async () => {
    await expect(
      assertCallableAddress('https://internal.example.com/.well-known', {
        allowPrivate: false,
        resolve: async () => ['10.0.0.1'],
      })
    ).rejects.toThrow(/private/)
  })

  test('a public address is allowed', async () => {
    await expect(
      assertCallableAddress('https://login.acme.example/.well-known', {
        allowPrivate: false,
        resolve: async () => ['8.8.8.8'],
      })
    ).resolves.toBeUndefined()
  })

  test('a deployment that allows the private addresses does not check them', async () => {
    await expect(
      assertCallableAddress('http://127.0.0.1:5556/.well-known', {
        allowPrivate: true,
        resolve: async () => ['127.0.0.1'],
      })
    ).resolves.toBeUndefined()
  })

  test('an address that is not a url is refused', async () => {
    await expect(assertCallableAddress('not a url', { allowPrivate: false })).rejects.toThrow(/url/)
  })

  test('a host that resolves to nothing is refused', async () => {
    await expect(
      assertCallableAddress('https://nowhere.example.com/.well-known', {
        allowPrivate: false,
        resolve: async () => [],
      })
    ).rejects.toThrow(/no address/)
  })
})
