/**
 * The mapping of an identity (spec §6.2, §6.4).
 *
 * The external identity of a caller is mapped to exactly one principal
 * row. The key of the mapping is the pair `(tenant, subject)`: an e-mail
 * is mutable and is not an identity.
 */

/** A principal of the platform, as the identity domain knows it. */
export interface Principal {
  id: string
  tenantId: string
  /** The slug of the tenant of the principal. */
  tenantSlug: string
  externalSubject: string
  email: string | null
  displayName: string | null
  status: 'active' | 'disabled'
}

/** The storage of the principals. */
export interface PrincipalLookup {
  /** The principal of an external identity of a tenant. */
  findByExternalSubject(tenantId: string, externalSubject: string): Promise<Principal | null>
  /** Creates a principal. */
  create(principal: {
    tenantId: string
    externalSubject: string
    email?: string | null
    displayName?: string | null
  }): Promise<Principal>
}

/** The tenant of an identity, as the mapping reads it. */
export interface TenantOfIdentity {
  id: string
  /** Whether an unknown external identity creates a principal row. */
  autoProvision: boolean
  enabled: boolean
}

/** The identity of a caller at the provider of a tenant. */
export interface ExternalIdentity {
  /** The subject of the provider. */
  subject: string
  /** The e-mail the provider publishes, when it publishes one. */
  email?: string | null
  /** The name the provider publishes, when it publishes one. */
  name?: string | null
}

/** The failure of a mapping. */
export class MappingError extends Error {
  constructor(
    /** The code of the failure. */
    readonly code: 'identity_unknown' | 'principal_disabled',
    message: string
  ) {
    super(message)
    this.name = 'MappingError'
  }
}

/** The result of a mapping. */
export interface Mapping {
  principal: Principal
  /** True when the principal was created by this login. */
  created: boolean
}

/**
 * Maps an external identity to a principal.
 *
 * An identity that nobody registered does not get an account because it
 * managed to log in somewhere: the tenant has to allow the
 * auto-provisioning, and a principal that is created has no grant at all.
 */
export async function mapIdentity(
  lookup: PrincipalLookup,
  tenant: TenantOfIdentity,
  identity: ExternalIdentity
): Promise<Mapping> {
  const existing = await lookup.findByExternalSubject(tenant.id, identity.subject)
  if (existing) {
    if (existing.status === 'disabled') {
      throw new MappingError('principal_disabled', 'the principal is disabled')
    }
    return { principal: existing, created: false }
  }

  if (!tenant.autoProvision) {
    throw new MappingError('identity_unknown', 'the identity is unknown to the platform')
  }

  const principal = await lookup.create({
    tenantId: tenant.id,
    externalSubject: identity.subject,
    email: identity.email ?? null,
    displayName: identity.name ?? null,
  })
  return { principal, created: true }
}
