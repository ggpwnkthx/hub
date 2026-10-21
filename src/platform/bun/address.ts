/**
 * The guard of the addresses of the providers (HUB-081).
 *
 * A tenant registers the issuer of its provider, and Hub calls that
 * address: the discovery document and the keys are the only outbound
 * calls. A tenant that registers an internal address would make Hub call
 * a service of the deployment with the credentials of the tenant.
 *
 * The address is checked before the call: the host is resolved and every
 * address it resolves to has to be a public one.
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/** The failure of the guard of an address. */
export class AddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AddressError'
  }
}

/** Reports whether an address is a private one. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true
    return false
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::1' || normalized === '::') return true
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    if (normalized.startsWith('fe80')) return true
    if (normalized.startsWith('::ffff:')) {
      return isPrivateAddress(normalized.slice('::ffff:'.length))
    }
    return false
  }
  return false
}

export interface GuardOptions {
  /** True when the deployment accepts the private addresses. */
  allowPrivate: boolean
  /** The resolver of the host; the tests give their own. */
  resolve?: (host: string) => Promise<string[]>
}

/**
 * Checks that an address may be called.
 *
 * The check is made on the addresses the host resolves to: a name that
 * resolves to a private address is refused, whatever the name says.
 */
export async function assertCallableAddress(url: string, options: GuardOptions): Promise<void> {
  if (options.allowPrivate) return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AddressError('the address of the provider is not a url')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AddressError('the address of the provider is not an http url')
  }
  const host = parsed.hostname
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new AddressError('the address of the provider is a private one')
    }
    return
  }
  const resolver = options.resolve ?? defaultResolve
  let addresses: string[]
  try {
    addresses = await resolver(host)
  } catch {
    throw new AddressError('the host of the provider cannot be resolved')
  }
  if (addresses.length === 0) {
    throw new AddressError('the host of the provider resolves to no address')
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new AddressError('the host of the provider resolves to a private address')
    }
  }
}

/** Resolves a host to its addresses. */
async function defaultResolve(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true })
  return found.map((entry) => entry.address)
}
