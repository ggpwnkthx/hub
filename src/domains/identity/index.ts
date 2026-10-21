/**
 * The identity of the callers.
 *
 * The domain owns the validation of the token of the provider of a tenant,
 * the mapping of the external identity `(tenant, subject)` to a principal
 * and the resolution of the tenant of a login. It knows nothing about the
 * protocol: it answers questions, the application turns the answers into
 * responses.
 */
export {}
