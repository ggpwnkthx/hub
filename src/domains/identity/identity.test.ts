import { describe, expect, test } from 'bun:test'
import {
  aChallenge,
  aVerifier,
  createStateCipher,
  domainOf,
  isAlive,
  LoginStateError,
  mapIdentity,
  MappingError,
  resolveTenant,
  TenantResolutionError,
  validateProviderToken,
  type LoginState,
  type Principal,
  type TenantOfLogin,
} from './index'

/** A tenant of the tests. */
function tenant(overrides: Partial<TenantOfLogin> = {}): TenantOfLogin {
  return {
    id: 'tenant-1',
    slug: 'acme',
    enabled: true,
    sharedClient: false,
    isDefault: false,
    autoProvision: false,
    issuer: 'https://login.acme.example',
    idpClientId: 'hub-acme',
    idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
    emailDomain: 'acme.example',
    clientId: 'shuttle-acme',
    scopes: ['openid', 'email', 'profile'],
    algorithms: ['RS256'],
    ...overrides,
  }
}

/** The storage of the tenants of the tests. */
function lookup(tenants: TenantOfLogin[]) {
  return {
    findByClientId: async (clientId: string) =>
      tenants.find((row) => row.clientId === clientId) ?? null,
    findBySlug: async (slug: string) => tenants.find((row) => row.slug === slug) ?? null,
    findByEmailDomain: async (domain: string) =>
      tenants.find((row) => row.emailDomain === domain) ?? null,
    findDefault: async () => tenants.find((row) => row.isDefault) ?? null,
  }
}

describe('the tenant of a login', () => {
  test('the client of the request names the tenant', async () => {
    const resolved = await resolveTenant(lookup([tenant()]), { clientId: 'shuttle-acme' })
    expect(resolved.slug).toBe('acme')
  })

  test('a client that names no tenant is refused', async () => {
    await expect(resolveTenant(lookup([tenant()]), { clientId: 'unknown' })).rejects.toThrow(
      TenantResolutionError
    )
  })

  test('a tenant that is disabled is refused', async () => {
    await expect(
      resolveTenant(lookup([tenant({ enabled: false })]), { clientId: 'shuttle-acme' })
    ).rejects.toThrow(/disabled/)
  })

  test('the parameter of the tenant is ignored when the client is not shared', async () => {
    const other = tenant({ slug: 'other', clientId: 'shuttle-other' })
    const resolved = await resolveTenant(lookup([tenant(), other]), {
      clientId: 'shuttle-acme',
      tenant: 'other',
    })
    expect(resolved.slug).toBe('acme')
  })

  test('the parameter of the tenant names it when the client is shared', async () => {
    const shared = tenant({ sharedClient: true })
    const other = tenant({ slug: 'other', clientId: 'shuttle-other' })
    const resolved = await resolveTenant(lookup([shared, other]), {
      clientId: 'shuttle-acme',
      tenant: 'other',
    })
    expect(resolved.slug).toBe('other')
  })

  test('the hint of the e-mail is ignored when the client is not shared', async () => {
    const other = tenant({ slug: 'other', clientId: 'shuttle-other', emailDomain: 'other.example' })
    const resolved = await resolveTenant(lookup([tenant(), other]), {
      clientId: 'shuttle-acme',
      loginHint: 'alice@other.example',
    })
    expect(resolved.slug).toBe('acme')
  })

  test('the hint of the e-mail names the tenant when the client is shared', async () => {
    const shared = tenant({ sharedClient: true })
    const other = tenant({ slug: 'other', clientId: 'shuttle-other', emailDomain: 'other.example' })
    const resolved = await resolveTenant(lookup([shared, other]), {
      clientId: 'shuttle-acme',
      loginHint: 'alice@other.example',
    })
    expect(resolved.slug).toBe('other')
  })

  test('the default tenant is the fallback of a shared client', async () => {
    const shared = tenant({ sharedClient: true })
    const fallback = tenant({ slug: 'fallback', clientId: 'shuttle-fallback', isDefault: true })
    const resolved = await resolveTenant(lookup([shared, fallback]), { clientId: 'shuttle-acme' })
    expect(resolved.slug).toBe('fallback')
  })

  test('the domain of an e-mail', () => {
    expect(domainOf('alice@acme.example')).toBe('acme.example')
    expect(domainOf('alice@ACME.example')).toBe('acme.example')
    expect(domainOf('alice')).toBeNull()
    expect(domainOf('@acme.example')).toBeNull()
  })
})

describe('the state of a login', () => {
  const state: LoginState = {
    tenant: 'acme',
    clientId: 'shuttle-acme',
    redirectUri: 'https://shuttle-acme.example.com/auth/callback',
    state: 'the-state-of-the-gateway',
    nonce: 'the-nonce',
    verifier: 'the-verifier',
    scopes: ['openid'],
    startedAt: Date.now(),
  }

  test('the state is encrypted and it comes back', () => {
    const cipher = createStateCipher('the-secret-of-the-deployment')
    const value = cipher.encrypt(state)
    expect(value).not.toContain('acme')
    expect(value).not.toContain('the-verifier')
    expect(cipher.decrypt(value)).toEqual(state)
  })

  test('a state that was changed does not come back', () => {
    const cipher = createStateCipher('the-secret-of-the-deployment')
    const value = cipher.encrypt(state)
    const changed = `${value.slice(0, -2)}aa`
    expect(() => cipher.decrypt(changed)).toThrow(LoginStateError)
  })

  test('another secret does not read the state', () => {
    const cipher = createStateCipher('the-secret-of-the-deployment')
    const other = createStateCipher('the-secret-of-another-deployment')
    expect(() => other.decrypt(cipher.encrypt(state))).toThrow(LoginStateError)
  })

  test('the state lives ten minutes', () => {
    expect(isAlive(state)).toBe(true)
    expect(isAlive({ ...state, startedAt: Date.now() - 601_000 })).toBe(false)
  })

  test('the challenge of the PKCE is the digest of the verifier', () => {
    const verifier = aVerifier()
    expect(aChallenge(verifier)).toHaveLength(43)
    expect(aChallenge(verifier)).not.toBe(aChallenge(aVerifier()))
  })
})

describe('the token of a provider', () => {
  const token = {
    issuer: 'https://login.acme.example',
    audience: 'hub-acme',
    subject: 'the-subject',
    nonce: 'the-nonce',
    algorithm: 'RS256',
    expiresAt: 1_700_000_300,
    issuedAt: 1_700_000_000,
  }
  const options = {
    expectedIssuer: 'https://login.acme.example',
    expectedAudience: 'hub-acme',
    expectedNonce: 'the-nonce',
    allowedAlgorithms: ['RS256'],
    skewSeconds: 60,
    now: 1_700_000_000,
  }

  test('a token that passes every check is accepted', () => {
    expect(validateProviderToken({ token, ...options }).subject).toBe('the-subject')
  })

  test('the issuer is compared exactly', () => {
    expect(() =>
      validateProviderToken({
        token: { ...token, issuer: 'https://login.acme.example/' },
        ...options,
      })
    ).toThrow(/issuer/)
  })

  test('the audience has to carry the client of the tenant', () => {
    expect(() =>
      validateProviderToken({ token: { ...token, audience: 'another-client' }, ...options })
    ).toThrow(/not for the client/)
    expect(
      validateProviderToken({
        token: { ...token, audience: 'another-client', authorizedParty: 'hub-acme' },
        ...options,
      }).subject
    ).toBe('the-subject')
  })

  test('the nonce has to be the one of the login', () => {
    expect(() =>
      validateProviderToken({ token: { ...token, nonce: 'another-nonce' }, ...options })
    ).toThrow(/nonce/)
  })

  test('the algorithm has to be one of the ones of the tenant', () => {
    expect(() =>
      validateProviderToken({ token: { ...token, algorithm: 'HS256' }, ...options })
    ).toThrow(/algorithm/)
    expect(() =>
      validateProviderToken({ token: { ...token, algorithm: 'none' }, ...options })
    ).toThrow(/algorithm/)
  })

  test('the clock of the token is checked with the tolerance', () => {
    expect(() =>
      validateProviderToken({ token: { ...token, expiresAt: 1_699_999_000 }, ...options })
    ).toThrow(/expired/)
    expect(() =>
      validateProviderToken({ token: { ...token, issuedAt: 1_700_000_120 }, ...options })
    ).toThrow(/not issued yet/)
  })

  test('the subject has to be there', () => {
    expect(() => validateProviderToken({ token: { ...token, subject: '' }, ...options })).toThrow(
      /subject/
    )
  })
})

describe('the mapping of an identity', () => {
  const principal: Principal = {
    id: 'principal-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    externalSubject: 'the-subject',
    email: null,
    displayName: null,
    status: 'active',
  }

  test('the identity is mapped to the principal of the pair', async () => {
    const mapping = await mapIdentity(
      {
        findByExternalSubject: async () => principal,
        create: async () => {
          throw new Error('the principal should not be created')
        },
      },
      tenant(),
      { subject: 'the-subject' }
    )
    expect(mapping.principal.id).toBe('principal-1')
    expect(mapping.created).toBe(false)
  })

  test('an identity that is not known is refused', async () => {
    await expect(
      mapIdentity(
        {
          findByExternalSubject: async () => null,
          create: async () => principal,
        },
        tenant(),
        { subject: 'the-subject' }
      )
    ).rejects.toThrow(MappingError)
  })

  test('an identity that is not known is created when the tenant allows it', async () => {
    const mapping = await mapIdentity(
      {
        findByExternalSubject: async () => null,
        create: async () => principal,
      },
      tenant({ autoProvision: true }),
      { subject: 'the-subject', email: 'alice@acme.example' }
    )
    expect(mapping.created).toBe(true)
    expect(mapping.principal.status).toBe('active')
  })

  test('a disabled principal is refused', async () => {
    await expect(
      mapIdentity(
        {
          findByExternalSubject: async () => ({ ...principal, status: 'disabled' }),
          create: async () => principal,
        },
        tenant(),
        { subject: 'the-subject' }
      )
    ).rejects.toThrow(/disabled/)
  })
})
