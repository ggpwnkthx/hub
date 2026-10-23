import { describe, expect, test } from 'bun:test'
import { isPrivateAddress, resolveCallableAddress } from './address'

describe('the addresses of the providers', () => {
  test('the private addresses are known', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('192.168.1.1')).toBe(true)
    expect(isPrivateAddress('169.254.1.1')).toBe(true)
    expect(isPrivateAddress('100.64.0.1')).toBe(true)
    expect(isPrivateAddress('192.0.0.1')).toBe(true)
    expect(isPrivateAddress('192.88.99.1')).toBe(true)
    expect(isPrivateAddress('198.18.0.1')).toBe(true)
    expect(isPrivateAddress('198.19.255.255')).toBe(true)
    expect(isPrivateAddress('224.0.0.1')).toBe(true)
    expect(isPrivateAddress('240.0.0.1')).toBe(true)
    expect(isPrivateAddress('255.255.255.255')).toBe(true)
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('fec0::1')).toBe(true)
    // The mapping of an IPv4 address in an IPv6 one, in both forms.
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true)
    // 6to4 and NAT64.
    expect(isPrivateAddress('2002:7f00:0001::')).toBe(true)
    expect(isPrivateAddress('64:ff9b::7f00:1')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2002:0808:0808::')).toBe(false)
  })

  test('an address that resolves to a private one is refused', async () => {
    await expect(
      resolveCallableAddress('https://internal.example.com/.well-known', {
        allowPrivate: false,
        resolve: async () => ['10.0.0.1'],
      })
    ).rejects.toThrow(/private/)
  })

  test('a public address is allowed', async () => {
    await expect(
      resolveCallableAddress('https://login.acme.example/.well-known', {
        allowPrivate: false,
        resolve: async () => ['8.8.8.8'],
      })
    ).resolves.toMatchObject({ url: 'https://8.8.8.8/.well-known' })
  })

  test('the call is made to the address that was checked', async () => {
    const target = await resolveCallableAddress('https://login.acme.example/.well-known', {
      allowPrivate: false,
      resolve: async () => ['8.8.8.8'],
    })
    // The address is the one of the check: the name does not resolve it a
    // second time.
    expect(target.url).toBe('https://8.8.8.8/.well-known')
    // The name of the host is still in the `Host` header and in the name
    // the certificate is checked against.
    expect(target.host).toBe('login.acme.example')
    expect(target.servername).toBe('login.acme.example')
    expect(target.secure).toBe(true)
  })

  test('the port of the url is kept', async () => {
    const target = await resolveCallableAddress('https://login.acme.example:8443/.well-known', {
      allowPrivate: false,
      resolve: async () => ['8.8.8.8'],
    })
    expect(target.url).toBe('https://8.8.8.8:8443/.well-known')
    expect(target.host).toBe('login.acme.example:8443')
    expect(target.servername).toBe('login.acme.example')
  })

  test('an address that is an address is not pinned', async () => {
    const target = await resolveCallableAddress('https://8.8.8.8/.well-known', {
      allowPrivate: false,
    })
    expect(target.url).toBe('https://8.8.8.8/.well-known')
    // The certificate of a call to an address is checked against it.
    expect(target.servername).toBe('')
  })

  test('a deployment that allows the private addresses does not check them', async () => {
    const target = await resolveCallableAddress('http://127.0.0.1:5556/.well-known', {
      allowPrivate: true,
      resolve: async () => ['127.0.0.1'],
    })
    expect(target.url).toBe('http://127.0.0.1:5556/.well-known')
    expect(target.secure).toBe(false)
  })

  test('an address that is not a url is refused', async () => {
    await expect(resolveCallableAddress('not a url', { allowPrivate: false })).rejects.toThrow(
      /url/
    )
  })

  test('an address that is not an http url is refused', async () => {
    await expect(
      resolveCallableAddress('file:///etc/passwd', { allowPrivate: false })
    ).rejects.toThrow(/http url/)
  })

  test('a host that resolves to nothing is refused', async () => {
    await expect(
      resolveCallableAddress('https://nowhere.example.com/.well-known', {
        allowPrivate: false,
        resolve: async () => [],
      })
    ).rejects.toThrow(/no address/)
  })
})
