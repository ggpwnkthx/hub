import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import {
  acceptedScopes,
  discoveryDocument,
  issueTokens,
  loadSigningKeys,
  MAX_ROLES,
  ProviderService,
  rolesClaim,
  SUPPORTED_SCOPES,
  TOKEN_LIFE_SECONDS,
} from './index'

/** A private key of the tests. */
function aKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

describe('the keys of Hub', () => {
  test('the key of the deployment is loaded and published', async () => {
    const keys = await loadSigningKeys({ key: aKey(), kid: 'hub-1' })
    expect(keys?.kid).toBe('hub-1')
    expect(keys?.published).toHaveLength(1)
    expect(keys?.published[0]?.jwk.kid).toBe('hub-1')
    expect(keys?.published[0]?.jwk.alg).toBe('RS256')
  })

  test('a deployment without a key has no key', async () => {
    expect(await loadSigningKeys({})).toBeNull()
  })

  test('a key that is not a private key stops the service', async () => {
    await expect(loadSigningKeys({ key: 'not a key', kid: 'hub-1' })).rejects.toThrow(
      /cannot be read/
    )
  })

  test('a key without an identifier is refused', async () => {
    await expect(loadSigningKeys({ key: aKey() })).rejects.toThrow(/identifier/)
  })

  test('the previous key of a rotation stays published', async () => {
    const keys = await loadSigningKeys({
      key: aKey(),
      kid: 'hub-2',
      previousKey: aKey(),
      previousKid: 'hub-1',
    })
    expect(keys?.published.map((key) => key.kid)).toEqual(['hub-2', 'hub-1'])
  })
})

describe('the tokens of Hub', () => {
  test('the id token carries the claims of the specification', async () => {
    const keys = await loadSigningKeys({ key: aKey(), kid: 'hub-1' })
    const pair = await issueTokens({
      keys: keys!,
      issuer: 'https://hub.example.com',
      subject: {
        subject: 'the-subject',
        tenant: 'acme',
        audience: 'shuttle-acme',
        email: 'alice@acme.example',
        displayName: 'Alice',
        nonce: 'the-nonce',
        scopes: ['openid', 'email'],
      },
      roles: ['workspace.read'],
      now: 1_700_000_000,
    })
    expect(pair.expiresIn).toBe(TOKEN_LIFE_SECONDS)
    expect(pair.tokenType).toBe('Bearer')

    const claims = decodeJwt(pair.idToken)
    expect(claims.iss).toBe('https://hub.example.com')
    expect(claims.sub).toBe('the-subject')
    expect(claims.aud).toBe('shuttle-acme')
    expect(claims.exp).toBe(1_700_000_000 + TOKEN_LIFE_SECONDS)
    expect(claims.iat).toBe(1_700_000_000)
    expect(claims.nonce).toBe('the-nonce')
    expect(claims.email).toBe('alice@acme.example')
    expect(claims.name).toBe('Alice')
    expect(claims.roles).toEqual(['workspace.read'])
    expect(claims.tid).toBe('acme')
    expect(claims.email_verified).toBe(false)
  })

  test('the access token carries the issuer, the audience and the scope', async () => {
    const keys = await loadSigningKeys({ key: aKey(), kid: 'hub-1' })
    const pair = await issueTokens({
      keys: keys!,
      issuer: 'https://hub.example.com',
      subject: {
        subject: 'the-subject',
        tenant: 'acme',
        audience: 'shuttle-acme',
        scopes: ['openid', 'email'],
      },
      roles: [],
      now: 1_700_000_000,
    })
    const claims = decodeJwt(pair.accessToken)
    expect(claims.iss).toBe('https://hub.example.com')
    expect(claims.aud).toBe('shuttle-acme')
    expect(claims.sub).toBe('the-subject')
    expect(claims.scope).toBe('openid email')
    expect(claims.exp).toBe(1_700_000_000 + TOKEN_LIFE_SECONDS)
  })

  test('there is no refresh token', async () => {
    const keys = await loadSigningKeys({ key: aKey(), kid: 'hub-1' })
    const pair = await issueTokens({
      keys: keys!,
      issuer: 'https://hub.example.com',
      subject: {
        subject: 'the-subject',
        tenant: 'acme',
        audience: 'shuttle-acme',
        scopes: ['openid'],
      },
      roles: [],
    })
    expect(Object.keys(pair).sort()).toEqual(['accessToken', 'expiresIn', 'idToken', 'tokenType'])
  })
})

describe('the roles claim of Hub', () => {
  test('the roles are sorted and without duplicates', () => {
    expect(rolesClaim(['workspace.write', 'workspace.read', 'workspace.read']).roles).toEqual([
      'workspace.read',
      'workspace.write',
    ])
  })

  test('the roles are capped at sixty-four', () => {
    const many = Array.from({ length: 70 }, (_, index) => `role-${index}`)
    const claim = rolesClaim(many)
    expect(claim.roles).toHaveLength(MAX_ROLES)
    expect(claim.dropped).toBe(6)
    expect(claim.roles[0]).toBe('role-0')
  })
})

describe('the discovery document of Hub', () => {
  test('it carries the fields the gateway reads', () => {
    const document = discoveryDocument({
      issuer: 'https://hub.example.com',
      publicUrl: 'https://hub.example.com',
    })
    expect(document.issuer).toBe('https://hub.example.com')
    expect(document.authorization_endpoint).toBe('https://hub.example.com/oauth/authorize')
    expect(document.token_endpoint).toBe('https://hub.example.com/oauth/token')
    expect(document.jwks_uri).toBe('https://hub.example.com/oauth/jwks')
    expect(document.userinfo_endpoint).toBe('https://hub.example.com/oauth/userinfo')
    expect(document.response_types_supported).toEqual(['code'])
    expect(document.subject_types_supported).toEqual(['public'])
    expect(document.id_token_signing_alg_values_supported).toEqual(['RS256'])
    expect(document.grant_types_supported).toEqual(['authorization_code'])
    expect(document.scopes_supported).toEqual(['openid', 'profile', 'email', 'groups'])
    expect(document.code_challenge_methods_supported).toEqual(['S256'])
    expect(document.token_endpoint_auth_methods_supported).toEqual(['client_secret_basic'])
  })

  test('a scope that Hub does not know is ignored', () => {
    expect(acceptedScopes(['openid', 'groups', 'something-else'])).toEqual(['openid', 'groups'])
    expect(SUPPORTED_SCOPES).toContain('groups')
  })
})

describe('the userinfo of Hub', () => {
  /** The service of the tests. */
  async function service(key: string, roles: string[] = []): Promise<ProviderService> {
    const provider = new ProviderService({
      signingKey: key,
      signingKid: 'hub-1',
      issuer: 'https://hub.example.com',
      publicUrl: 'https://hub.example.com',
      // The roles of a token are the live grants of the principal: the
      // service never invents them.
      roles: { roleKeys: async () => roles },
      principals: {
        findById: async (id) => ({
          id,
          email: 'alice@acme.example',
          displayName: 'Alice',
          status: 'active',
        }),
      },
      audiences: { isKnown: async (clientId) => clientId === 'shuttle-acme' },
    })
    await provider.load()
    return provider
  }

  test('the claims of the principal of a token are answered', async () => {
    const key = aKey()
    const provider = await service(key, ['workspace.read'])
    const pair = await provider.issueTokens({
      subject: 'the-subject',
      tenant: 'acme',
      audience: 'shuttle-acme',
      email: 'alice@acme.example',
      displayName: 'Alice',
      scopes: ['openid'],
    })
    const claims = await provider.userinfo(pair.accessToken)
    expect(claims).toEqual({
      sub: 'the-subject',
      email: 'alice@acme.example',
      name: 'Alice',
      roles: ['workspace.read'],
    })
  })

  test('a token that is signed with another key is refused', async () => {
    const provider = await service(aKey())
    const other = await service(aKey())
    const pair = await other.issueTokens({
      subject: 'the-subject',
      tenant: 'acme',
      audience: 'shuttle-acme',
      scopes: [],
    })
    expect(await provider.userinfo(pair.accessToken)).toBeNull()
  })

  test('a token that has expired is refused', async () => {
    const key = aKey()
    const provider = await service(key)
    const keys = await loadSigningKeys({ key, kid: 'hub-1' })
    const pair = await issueTokens({
      keys: keys!,
      issuer: 'https://hub.example.com',
      subject: { subject: 'the-subject', tenant: 'acme', audience: 'shuttle-acme', scopes: [] },
      roles: [],
      now: Math.floor(Date.now() / 1000) - 3_600,
    })
    expect(await provider.userinfo(pair.accessToken)).toBeNull()
  })

  test('a token of another issuer is refused', async () => {
    const key = aKey()
    const provider = await service(key)
    const keys = await loadSigningKeys({ key, kid: 'hub-1' })
    const pair = await issueTokens({
      keys: keys!,
      issuer: 'https://another.example.com',
      subject: { subject: 'the-subject', tenant: 'acme', audience: 'shuttle-acme', scopes: [] },
      roles: [],
    })
    expect(await provider.userinfo(pair.accessToken)).toBeNull()
  })

  test('a token of another audience is refused', async () => {
    const key = aKey()
    const provider = await service(key)
    const pair = await provider.issueTokens({
      subject: 'the-subject',
      tenant: 'acme',
      audience: 'shuttle-another',
      scopes: [],
    })
    expect(await provider.userinfo(pair.accessToken)).toBeNull()
  })
})
