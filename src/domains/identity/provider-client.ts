/**
 * The client of the provider of a tenant (spec §5.4).
 *
 * The client speaks to the provider of a tenant: it reads the discovery
 * document, it builds the url of the authorization, it exchanges the code
 * and it verifies the id token. The discovery document and the keys are
 * cached for ten minutes: a login does not call the provider of a tenant
 * on every request.
 */

/** The answer of an outbound call. */
export interface TransportResponse {
  status: number
  body: string
}

/** The transport of the outbound calls. */
export interface HttpTransport {
  /** Calls a url. */
  call: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number }
  ) => Promise<TransportResponse>
}

/**
 * The guard of the addresses of the providers.
 *
 * A tenant registers the issuer of its provider: the address is checked
 * before the call, so a tenant cannot make Hub call a service of the
 * deployment.
 */
export interface AddressGuard {
  /** Refuses the addresses that the deployment may not call. */
  assert: (url: string) => Promise<void>
}

/** The failure of a call to the provider of a tenant. */
export class ProviderError extends Error {
  constructor(
    /** The code of the failure. */
    readonly code: 'upstream_unavailable' | 'identity_rejected' | 'provider_error',
    message: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** The discovery document of a provider. */
export interface ProviderDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

/** The client of the provider of a tenant. */
export class ProviderClient {
  private discoveryCache: { document: ProviderDiscovery; at: number } | null = null
  private jwksCache: { keys: unknown; at: number } | null = null
  /** The moment of the last refresh of the keys of the provider. */
  private jwksRefreshedAt: number | null = null

  constructor(
    private readonly options: {
      issuer: string
      clientId: string
      clientSecret: string
      redirectUri: string
      scopes: string[]
      algorithms: string[]
      transport: HttpTransport
      /** The guard of the addresses; without it every address is allowed. */
      guard?: AddressGuard
      cacheTtlMs?: number
      /** How long two refreshes of the keys are apart, in milliseconds. */
      refreshIntervalMs?: number
      now?: () => number
      /** How long a call to the provider may take, in milliseconds. */
      timeoutMs?: number
    }
  ) {}

  /** How long the discovery document and the keys are cached. */
  private get ttl(): number {
    return this.options.cacheTtlMs ?? 600_000
  }

  /** How long two refreshes of the keys are apart. */
  private get refreshInterval(): number {
    return this.options.refreshIntervalMs ?? 30_000
  }

  /** The moment of the cache. */
  private get now(): number {
    return (this.options.now ?? (() => Date.now()))()
  }

  /**
   * Calls the provider.
   *
   * A provider that cannot be reached is a refusal of the login: the
   * reason of the failure of the network never reaches the caller.
   */
  private async call(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ): Promise<TransportResponse> {
    try {
      await this.options.guard?.assert(url)
      return await this.options.transport.call(url, {
        ...init,
        timeoutMs: this.options.timeoutMs ?? 5_000,
      })
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError('upstream_unavailable', 'the provider of the tenant is not reachable')
    }
  }

  /**
   * The discovery document of the provider.
   *
   * The issuer of the document has to be exactly the issuer of the
   * tenant: a provider that names another issuer is refused, for the same
   * reason the gateway refuses it.
   */
  async discovery(): Promise<ProviderDiscovery> {
    if (this.discoveryCache && this.now - this.discoveryCache.at < this.ttl) {
      return this.discoveryCache.document
    }
    const url = `${this.options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
    const response = await this.call(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    if (response.status !== 200) {
      throw new ProviderError(
        'upstream_unavailable',
        'the discovery document of the provider could not be read'
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(response.body)
    } catch {
      throw new ProviderError(
        'provider_error',
        'the discovery document of the provider is not json'
      )
    }
    const document = parsed as Partial<ProviderDiscovery>
    if (
      typeof document.issuer !== 'string' ||
      typeof document.authorization_endpoint !== 'string' ||
      typeof document.token_endpoint !== 'string' ||
      typeof document.jwks_uri !== 'string'
    ) {
      throw new ProviderError(
        'provider_error',
        'the discovery document of the provider is incomplete'
      )
    }
    if (document.issuer !== this.options.issuer) {
      throw new ProviderError(
        'identity_rejected',
        'the issuer of the provider is not the issuer of the tenant'
      )
    }
    const complete: ProviderDiscovery = {
      issuer: document.issuer,
      authorization_endpoint: document.authorization_endpoint,
      token_endpoint: document.token_endpoint,
      jwks_uri: document.jwks_uri,
    }
    this.discoveryCache = { document: complete, at: this.now }
    return complete
  }

  /** The keys of the provider. */
  async jwks(options: { refresh?: boolean } = {}): Promise<unknown> {
    const fresh = this.jwksCache !== null && this.now - this.jwksCache.at < this.ttl
    if (fresh && !options.refresh) {
      return this.jwksCache!.keys
    }
    // A refresh is not done on every call: a provider that is hammered
    // with tokens it did not sign is not hammered with calls (spec §6.6).
    // The first refresh of a rotation is always allowed.
    if (
      options.refresh &&
      this.jwksRefreshedAt !== null &&
      this.now - this.jwksRefreshedAt < this.refreshInterval
    ) {
      return this.jwksCache!.keys
    }
    const discovery = await this.discovery()
    const response = await this.call(discovery.jwks_uri, {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    if (response.status !== 200) {
      throw new ProviderError('upstream_unavailable', 'the keys of the provider could not be read')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(response.body)
    } catch {
      throw new ProviderError('provider_error', 'the keys of the provider are not json')
    }
    this.jwksCache = { keys: parsed, at: this.now }
    if (options.refresh) {
      this.jwksRefreshedAt = this.now
    }
    return parsed
  }

  /**
   * The url of the authorization of the provider.
   *
   * Hub sends a fresh state and a fresh nonce, and the challenge of the
   * PKCE: the verifier stays in the state cookie of the login.
   */
  async authorizationUrl(options: {
    state: string
    nonce: string
    challenge: string
    scopes: string[]
  }): Promise<string> {
    const discovery = await this.discovery()
    const url = new URL(discovery.authorization_endpoint)
    url.searchParams.set('client_id', this.options.clientId)
    url.searchParams.set('redirect_uri', this.options.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', options.scopes.join(' '))
    url.searchParams.set('state', options.state)
    url.searchParams.set('nonce', options.nonce)
    url.searchParams.set('code_challenge', options.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  }

  /**
   * Exchanges the code of the provider for its id token.
   *
   * The client authenticates itself with its secret and it presents the
   * verifier of the PKCE: a provider that does not support the PKCE is
   * refused at the registration of the tenant.
   */
  async exchange(options: { code: string; verifier: string }): Promise<string> {
    const discovery = await this.discovery()
    const authorization = Buffer.from(
      `${this.options.clientId}:${this.options.clientSecret}`
    ).toString('base64')
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: this.options.redirectUri,
      client_id: this.options.clientId,
      code_verifier: options.verifier,
    })
    const response = await this.call(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${authorization}`,
      },
      body: body.toString(),
    })
    if (response.status !== 200) {
      throw new ProviderError('provider_error', 'the provider refused the exchange of the code')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(response.body)
    } catch {
      throw new ProviderError('provider_error', 'the answer of the provider is not json')
    }
    const idToken = (parsed as { id_token?: unknown }).id_token
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw new ProviderError('provider_error', 'the answer of the provider has no id token')
    }
    return idToken
  }
}
