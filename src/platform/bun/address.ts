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
 *
 * The check and the call use the **same** address. The guard resolves the
 * host and pins the address it resolved to, and the call is made to that
 * address, with the name of the host in the `Host` header and in the
 * name the certificate is checked against. A host that answers a public
 * address to the check and a private one to the connection is therefore
 * of no use: the connection is made to the address that was checked.
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/** The failure of the guard of an address. */
class AddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AddressError'
  }
}

/**
 * The target of a call: the address it is made to, and the name of the
 * host it is made for.
 */
export interface CallTarget {
  /** The url the call is made to. */
  url: string
  /** The value of the `Host` header of the call. */
  host: string
  /**
   * The name the certificate of the call is checked against.
   *
   * It is empty when the host of the url is an address: the certificate
   * is then checked against that address.
   */
  servername: string
  /** True when the call is over https. */
  secure: boolean
}

/** Turns two hexadecimal hextets into the IPv4 address they carry. */
function ipv4Of(high: string, low: string): string {
  const first = Number.parseInt(high, 16)
  const second = Number.parseInt(low, 16)
  return `${first >> 8}.${first & 0xff}.${second >> 8}.${second & 0xff}`
}

/** Reports whether an address is a private one. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
    if (a === 192 && b !== undefined && b === 168) return true
    // The assignments of the IETF (192.0.0.0/24) and the anycast of the
    // 6to4 (192.88.99.0/24).
    if (a === 192 && b !== undefined && (b === 0 || (b === 88 && c === 99))) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true
    // The addresses of the benchmarks (198.18.0.0/15).
    if (a === 198 && b !== undefined && (b === 18 || b === 19)) return true
    // The multicast (224.0.0.0/4), the reserved (240.0.0.0/4) and the
    // broadcast.
    if (a !== undefined && a >= 224) return true
    return false
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::1' || normalized === '::') return true
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    if (normalized.startsWith('fe80')) return true
    if (normalized.startsWith('fec0')) return true
    // The mapping of an IPv4 address in an IPv6 one: the address that is
    // mapped is the one that is checked.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized)
    if (mapped) return isPrivateAddress(ipv4Of(mapped[1]!, mapped[2]!))
    const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized)
    if (dotted) return isPrivateAddress(dotted[1]!)
    // 6to4: the IPv4 address is the two hextets that follow the prefix.
    const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/.exec(normalized)
    if (sixToFour) return isPrivateAddress(ipv4Of(sixToFour[1]!, sixToFour[2]!))
    // NAT64: the IPv4 address is the two last hextets.
    const nat64 = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized)
    if (nat64) return isPrivateAddress(ipv4Of(nat64[1]!, nat64[2]!))
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
 * Checks that an address may be called, and pins it.
 *
 * The check is made on the addresses the host resolves to: a name that
 * resolves to a private address is refused, whatever the name says. The
 * address that was checked is the address the call is made to.
 */
export async function resolveCallableAddress(
  url: string,
  options: GuardOptions
): Promise<CallTarget> {
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
  const secure = parsed.protocol === 'https:'

  // A development machine accepts the private addresses: the call is made
  // to the name, as it is written, and the name is resolved by the
  // runtime.
  if (options.allowPrivate) {
    return {
      url: parsed.toString(),
      host: parsed.host,
      servername: isIP(host) === 0 ? host : '',
      secure,
    }
  }

  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new AddressError('the address of the provider is a private one')
    }
    return {
      url: parsed.toString(),
      host: parsed.host,
      servername: '',
      secure,
    }
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

  // The call is made to the address that was checked: the name does not
  // resolve it a second time, and it cannot answer another one.
  const pinned = new URL(parsed.toString())
  pinned.hostname = addresses[0]!.includes(':') ? `[${addresses[0]}]` : addresses[0]!
  return {
    url: pinned.toString(),
    host: parsed.host,
    servername: host,
    secure,
  }
}

/** Resolves a host to its addresses. */
async function defaultResolve(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true })
  return found.map((entry) => entry.address)
}
