/**
 * The validation of the bodies of the administration (spec §10).
 *
 * A body is validated before the database is touched: an answer that
 * refuses a body never opens a connection. The schemas are the shape of
 * the specification, the rules of the answers are the ones of the
 * service.
 */

import { z } from 'zod'

/** The name of a tenant. */
export const SLUG_PATTERN = /^[a-z0-9-]{2,63}$/

/** The name of a permission. */
export const PERMISSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** The body of the creation and of the change of a tenant. */
export const TenantBody = z.object({
  slug: z.string().regex(SLUG_PATTERN, 'the slug is [a-z0-9-] and is 2 to 63 characters long'),
  displayName: z.string().min(1, 'the name of the tenant is required'),
  issuer: z.string().url('the issuer of the provider must be a url'),
  idpClientId: z.string().min(1, 'the client id at the provider is required'),
  idpClientSecret: z.string().min(1, 'the client secret at the provider is required'),
  idpRedirectUri: z.string().url('the callback at the provider must be a url').optional(),
  idpScopes: z.array(z.string().min(1)).optional(),
  idpAlgorithms: z.array(z.string().min(1)).optional(),
  emailDomain: z.string().min(1).nullable().optional(),
  clientId: z.string().min(1, 'the client id of the gateway is required'),
  clientSecret: z.string().min(1, 'the secret of the gateway is required'),
  clientRedirectUris: z.array(z.string().url('a redirect uri is a url')).optional().default([]),
  autoProvision: z.boolean().optional(),
  sharedClient: z.boolean().optional(),
  default: z.boolean().optional(),
  enabled: z.boolean().optional(),
})

/** The body of the creation and of the change of a principal. */
export const PrincipalBody = z.object({
  tenant: z.string().regex(SLUG_PATTERN, 'the tenant is the slug of a tenant of the platform'),
  externalSubject: z.string().min(1, 'the subject of the provider is required'),
  email: z.string().email('the e-mail is not an address').nullable().optional(),
  displayName: z.string().min(1).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
})

/** The body of the creation and of the change of a grant. */
export const GrantBody = z
  .object({
    tenant: z.string().regex(SLUG_PATTERN, 'the tenant is the slug of a tenant of the platform'),
    userId: z.string().uuid('the principal is an id').nullable().optional(),
    group: z
      .string()
      .regex(PERMISSION_PATTERN, 'the group is [a-z0-9] and is 64 characters long at most')
      .nullable()
      .optional(),
    permission: z
      .string()
      .regex(PERMISSION_PATTERN, 'the permission is [a-z0-9] and is 64 characters long at most'),
    workspaceId: z.string().min(1).nullable().optional(),
    routeId: z.string().min(1).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    grantedBy: z.string().min(1).nullable().optional(),
  })
  .refine((body) => (body.userId ?? null) !== (body.group ?? null), {
    message: 'the grant names a principal or a group, and not both',
  })

/** The body of the creation and of the change of a group. */
export const GroupBody = z.object({
  tenant: z.string().regex(SLUG_PATTERN, 'the tenant is the slug of a tenant of the platform'),
  key: z
    .string()
    .regex(
      PERMISSION_PATTERN,
      'the key of the group is [a-z0-9] and is 64 characters long at most'
    ),
  displayName: z.string().min(1).nullable().optional(),
  members: z.array(z.string().min(1)).optional(),
})

/**
 * The maximum number of items of a batch of the administration.
 *
 * A batch is the call that writes many principals or many grants at
 * once: it is the call that onboards a tenant. The number is a ceiling,
 * not a promise: a bigger batch is written in several calls.
 */
export const MAX_BATCH_ITEMS = 1000

/** The body of a batch of principals. */
export const PrincipalBatchBody = z.object({
  principals: z
    .array(PrincipalBody, {
      message: 'the principals of the batch are the principals of the tenant',
    })
    .min(1, 'the batch holds at least one principal')
    .max(MAX_BATCH_ITEMS, `the batch holds at most ${MAX_BATCH_ITEMS} principals`),
})

/** The body of a batch of grants. */
export const GrantBatchBody = z.object({
  grants: z
    .array(GrantBody, { message: 'the grants of the batch are the grants of the tenant' })
    .min(1, 'the batch holds at least one grant')
    .max(MAX_BATCH_ITEMS, `the batch holds at most ${MAX_BATCH_ITEMS} grants`),
})

/** The parsed body of a tenant. */
export type TenantInput = z.infer<typeof TenantBody>
/** The parsed body of a principal. */
export type PrincipalInput = z.infer<typeof PrincipalBody>
/** The parsed body of a grant. */
export type GrantInput = z.infer<typeof GrantBody>
/** The parsed body of a group. */
export type GroupInput = z.infer<typeof GroupBody>
/** The parsed body of a batch of principals. */
export type PrincipalBatchInput = z.infer<typeof PrincipalBatchBody>
/** The parsed body of a batch of grants. */
export type GrantBatchInput = z.infer<typeof GrantBatchBody>
