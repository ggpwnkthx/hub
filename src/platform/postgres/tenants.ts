/**
 * The tenants of Hub (spec §3.1).
 *
 * The repository is the storage of the rows: it holds no policy. The rules
 * of a tenant live in the domains that use it, and the answers of the
 * protocol are built there.
 *
 * The two client secrets of a tenant are encrypted before they are
 * written and they are never returned in clear by the methods of the
 * listing: only the two methods that read a secret decrypt it, and only
 * for the caller that needs it.
 */

import type { SqlClient } from './database'
import { sameSecret } from '../../observability'
import { SecretError, type SecretCipher } from './secrets'
import { auditedCte } from './audited'
import type { ChangeAudit } from '../../domains/administration'

/** The row of a tenant. */
export interface TenantRow {
  id: string
  slug: string
  displayName: string
  enabled: boolean
  isDefault: boolean
  autoProvision: boolean
  emailDomain: string | null
  idpIssuer: string
  idpClientId: string
  /** The client secret of Hub at the provider, encrypted at rest. */
  idpClientSecret: Uint8Array
  idpRedirectUri: string
  idpScopes: string[]
  idpAlgorithms: string[]
  clientId: string
  /** The secret of the gateway of the tenant, encrypted at rest. */
  clientSecret: Uint8Array
  /**
   * The urls the gateway of the tenant is registered with.
   *
   * The browser is sent back to one of them with the code of the login:
   * a url that is not in this list is never sent a code (spec §5.2).
   */
  clientRedirectUris: string[]
  /**
   * The secret that the current one replaced, encrypted at rest.
   *
   * It is accepted until `previousClientSecretUntil`: a rotation of the
   * secret of a gateway is a rolling change, and a window in which the
   * two secrets are accepted is what makes it one.
   */
  previousClientSecret: Uint8Array | null
  /** The moment the previous secret stops being accepted. */
  previousClientSecretUntil: Date | null
  sharedClient: boolean
  createdAt: Date
  updatedAt: Date
}

/** A tenant with the numbers of its principals and of its grants. */
export interface TenantSummary extends TenantRow {
  userCount: number
  grantCount: number
}

/** The fields of the creation of a tenant. */
export interface NewTenant {
  slug: string
  displayName: string
  /** The issuer of the provider of the tenant. */
  issuer: string
  idpClientId: string
  /** The client secret of Hub at the provider, in clear. */
  idpClientSecret: string
  idpRedirectUri: string
  idpScopes: string[]
  idpAlgorithms: string[]
  emailDomain?: string | null
  clientId: string
  /** The secret of the gateway of the tenant, in clear. */
  clientSecret: string
  /** The urls the gateway of the tenant is registered with. */
  clientRedirectUris?: string[]
  autoProvision?: boolean
  sharedClient?: boolean
  isDefault?: boolean
  enabled?: boolean
}

/** The fields of the change of a tenant. Every field is optional. */
export interface TenantUpdate {
  displayName?: string
  issuer?: string
  idpClientId?: string
  idpClientSecret?: string
  idpRedirectUri?: string
  idpScopes?: string[]
  idpAlgorithms?: string[]
  emailDomain?: string | null
  clientId?: string
  clientSecret?: string
  clientRedirectUris?: string[]
  autoProvision?: boolean
  sharedClient?: boolean
  isDefault?: boolean
  enabled?: boolean
}

/** The row of a tenant, as the database holds it. */
interface TenantRecord {
  id: string
  slug: string
  display_name: string
  enabled: boolean
  is_default: boolean
  auto_provision: boolean
  email_domain: string | null
  idp_issuer: string
  idp_client_id: string
  idp_client_secret: Uint8Array
  idp_redirect_uri: string
  idp_scopes: string[]
  idp_algorithms: string[]
  client_id: string
  client_secret: Uint8Array
  client_redirect_uris: string[]
  previous_client_secret: Uint8Array | null
  previous_client_secret_until: Date | null
  shared_client: boolean
  created_at: Date
  updated_at: Date
}

/** The columns of a tenant. */
const COLUMNS = `id, slug, display_name, enabled, is_default, auto_provision, email_domain,
  idp_issuer, idp_client_id, idp_client_secret, idp_redirect_uri, idp_scopes, idp_algorithms,
  client_id, client_secret, client_redirect_uris, previous_client_secret,
  previous_client_secret_until, shared_client, created_at, updated_at`

/**
 * The window during which the secret that a rotation replaced is still
 * accepted.
 *
 * The window is long enough for a gateway to be restarted with the new
 * secret and short enough for the old secret not to be a permanent second
 * credential of the tenant.
 */
export const SECRET_ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000

/** Turns the row of the database into the row of the domain. */
function toRow(record: TenantRecord): TenantRow {
  return {
    id: record.id,
    slug: record.slug,
    displayName: record.display_name,
    enabled: record.enabled,
    isDefault: record.is_default,
    autoProvision: record.auto_provision,
    emailDomain: record.email_domain,
    idpIssuer: record.idp_issuer,
    idpClientId: record.idp_client_id,
    idpClientSecret: record.idp_client_secret,
    idpRedirectUri: record.idp_redirect_uri,
    idpScopes: record.idp_scopes,
    idpAlgorithms: record.idp_algorithms,
    clientId: record.client_id,
    clientSecret: record.client_secret,
    clientRedirectUris: record.client_redirect_uris,
    previousClientSecret: record.previous_client_secret,
    previousClientSecretUntil: record.previous_client_secret_until,
    sharedClient: record.shared_client,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

/** The secrets of the gateway of a tenant, in clear. */
export interface GatewaySecrets {
  /** The secret that is in use. */
  current: string | null
  /** The secret that the current one replaced, when it is still accepted. */
  previous: string | null
  /** The moment the previous secret stops being accepted. */
  previousUntil: Date | null
}

/** The storage of the tenants. */
export class TenantRepository {
  constructor(
    private readonly db: SqlClient,
    /** The cipher of the client secrets; without it a tenant cannot be written. */
    private readonly cipher?: SecretCipher
  ) {}

  /** The tenant of an id. */
  async findById(id: string): Promise<TenantRow | null> {
    const rows = await this.db.query<TenantRecord>(`select ${COLUMNS} from tenants where id = $1`, [
      id,
    ])
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The tenant of a slug: the slug is the key of the row. */
  async findBySlug(slug: string): Promise<TenantRow | null> {
    const rows = await this.db.query<TenantRecord>(
      `select ${COLUMNS} from tenants where slug = $1`,
      [slug]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The tenant of a client id of a gateway. */
  async findByClientId(clientId: string): Promise<TenantRow | null> {
    const rows = await this.db.query<TenantRecord>(
      `select ${COLUMNS} from tenants where client_id = $1`,
      [clientId]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The tenant of an e-mail domain: the domain is a hint, never a key. */
  async findByEmailDomain(emailDomain: string): Promise<TenantRow | null> {
    const rows = await this.db.query<TenantRecord>(
      `select ${COLUMNS} from tenants where email_domain = $1`,
      [emailDomain]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The tenant that is the default of the platform. */
  async findDefault(): Promise<TenantRow | null> {
    const rows = await this.db.query<TenantRecord>(
      `select ${COLUMNS} from tenants where is_default limit 1`
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The tenants of the platform, with their numbers. */
  async list(): Promise<TenantSummary[]> {
    const rows = await this.db.query<TenantRecord & { user_count: number; grant_count: number }>(
      `select ${COLUMNS},
         (select count(*) from users where users.tenant_id = tenants.id)::int as user_count,
         (select count(*) from grants where grants.tenant_id = tenants.id)::int as grant_count
       from tenants order by slug`
    )
    return rows.map((row) => ({
      ...toRow(row),
      userCount: row.user_count,
      grantCount: row.grant_count,
    }))
  }

  /**
   * Creates a tenant.
   *
   * The row of the audit of the creation is written by the same
   * statement as the tenant: a tenant that is not audited does not
   * exist (spec §9.1).
   */
  async create(input: NewTenant, audit?: ChangeAudit | null): Promise<TenantRow> {
    const params: unknown[] = [
      input.slug,
      input.displayName,
      input.issuer,
      input.idpClientId,
      this.encrypted(input.idpClientSecret),
      input.idpRedirectUri,
      input.idpScopes,
      input.idpAlgorithms,
      input.emailDomain ?? null,
      input.clientId,
      this.encrypted(input.clientSecret),
      input.clientRedirectUris ?? [],
      input.autoProvision ?? false,
      input.sharedClient ?? false,
      input.isDefault ?? false,
      input.enabled ?? true,
    ]
    const audited = auditedCte('inserted', params, audit)
    const rows = await this.db.query<TenantRecord>(
      `with inserted as (
         insert into tenants (slug, display_name, idp_issuer, idp_client_id, idp_client_secret,
           idp_redirect_uri, idp_scopes, idp_algorithms, email_domain, client_id, client_secret,
           client_redirect_uris, auto_provision, shared_client, is_default, enabled)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         returning ${COLUMNS}
       )${audited}
       select ${COLUMNS} from inserted`,
      params
    )
    return toRow(rows[0]!)
  }

  /**
   * Changes a tenant.
   *
   * A secret that is not given keeps the one that is stored: a caller
   * that changes the name of a tenant does not have to know its secrets.
   *
   * The row of the audit of the change is written by the same statement
   * as the tenant (spec §9.1).
   */
  async update(
    id: string,
    input: TenantUpdate,
    audit?: ChangeAudit | null
  ): Promise<TenantRow | null> {
    const assignments: string[] = []
    const params: unknown[] = []
    const set = (column: string, value: unknown): void => {
      params.push(value)
      assignments.push(`${column} = $${params.length}`)
    }
    if (input.displayName !== undefined) set('display_name', input.displayName)
    if (input.issuer !== undefined) set('idp_issuer', input.issuer)
    if (input.idpClientId !== undefined) set('idp_client_id', input.idpClientId)
    if (input.idpClientSecret !== undefined) {
      set('idp_client_secret', this.encrypted(input.idpClientSecret))
    }
    if (input.idpRedirectUri !== undefined) set('idp_redirect_uri', input.idpRedirectUri)
    if (input.idpScopes !== undefined) set('idp_scopes', input.idpScopes)
    if (input.idpAlgorithms !== undefined) set('idp_algorithms', input.idpAlgorithms)
    if (input.emailDomain !== undefined) set('email_domain', input.emailDomain)
    if (input.clientId !== undefined) set('client_id', input.clientId)
    if (input.clientRedirectUris !== undefined) {
      set('client_redirect_uris', input.clientRedirectUris)
    }
    if (input.clientSecret !== undefined) {
      // The secret that is replaced is kept for the window of the
      // rotation: the two secrets are accepted until the window is over,
      // and the rotation is then a rolling change (spec §4.3).
      //
      // A call that presents the secret that is already in use is not a
      // rotation: the window of the rotation that is in flight is not
      // closed by an unrelated change of the tenant.
      const current = await this.readGatewaySecret(id)
      if (current && !sameSecret(input.clientSecret, current)) {
        set('previous_client_secret', this.encrypted(current))
        set('previous_client_secret_until', new Date(Date.now() + SECRET_ROTATION_WINDOW_MS))
      }
      set('client_secret', this.encrypted(input.clientSecret))
    }
    if (input.autoProvision !== undefined) set('auto_provision', input.autoProvision)
    if (input.sharedClient !== undefined) set('shared_client', input.sharedClient)
    if (input.isDefault !== undefined) set('is_default', input.isDefault)
    if (input.enabled !== undefined) set('enabled', input.enabled)
    if (assignments.length === 0) {
      // The call changed nothing, but it is still a call of the
      // administration: the row is rewritten with the values it has, so
      // that the row of the audit is written by the same statement as
      // the row it names.
      assignments.push('id = id')
    } else {
      set('updated_at', new Date())
    }
    params.push(id)
    // The number of the id is read before the audit is appended: the
    // parameters of the audit are always the last five.
    const idParam = params.length
    const audited = auditedCte('updated', params, audit)
    const rows = await this.db.query<TenantRecord>(
      `with updated as (
         update tenants set ${assignments.join(', ')} where id = $${idParam}
         returning ${COLUMNS}
       )${audited}
       select ${COLUMNS} from updated`,
      params
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The client secret of Hub at the provider, in clear. */
  async readProviderSecret(id: string): Promise<string | null> {
    const rows = await this.db.query<{ idp_client_secret: Uint8Array }>(
      `select idp_client_secret from tenants where id = $1`,
      [id]
    )
    const stored = rows[0]?.idp_client_secret
    if (!stored) return null
    return this.decrypted(stored)
  }

  /** The secret of the gateway of the tenant, in clear. */
  async readGatewaySecret(id: string): Promise<string | null> {
    const rows = await this.db.query<{ client_secret: Uint8Array }>(
      `select client_secret from tenants where id = $1`,
      [id]
    )
    const stored = rows[0]?.client_secret
    if (!stored) return null
    return this.decrypted(stored)
  }

  /**
   * The secrets of the gateway of the tenant, in clear.
   *
   * There are two of them during a rotation: the current one and the one
   * it replaced, which is accepted until its window is over. The
   * comparison of the two is in constant time and it is the caller that
   * does it (spec §8.8).
   */
  async readGatewaySecrets(id: string): Promise<GatewaySecrets> {
    const rows = await this.db.query<{
      client_secret: Uint8Array
      previous_client_secret: Uint8Array | null
      previous_client_secret_until: Date | null
    }>(
      `select client_secret, previous_client_secret, previous_client_secret_until
         from tenants where id = $1`,
      [id]
    )
    const row = rows[0]
    if (!row) return { current: null, previous: null, previousUntil: null }
    const previous =
      row.previous_client_secret && row.previous_client_secret_until
        ? this.decrypted(row.previous_client_secret)
        : null
    return {
      current: this.decrypted(row.client_secret),
      previous,
      previousUntil: previous ? row.previous_client_secret_until : null,
    }
  }

  /** Encrypts a secret that is written. */
  private encrypted(clear: string): Uint8Array {
    if (!this.cipher) {
      throw new SecretError(
        'the client secrets cannot be encrypted: the key of the deployment is not set'
      )
    }
    return this.cipher.encrypt(clear)
  }

  /** Decrypts a secret that is read. */
  private decrypted(stored: Uint8Array): string {
    if (!this.cipher) {
      throw new SecretError(
        'the client secrets cannot be read: the key of the deployment is not set'
      )
    }
    return this.cipher.decrypt(stored)
  }
}
