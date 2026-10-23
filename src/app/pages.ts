/**
 * The pages of the refusals of the login (spec §5.6).
 *
 * A page shows what happened and nothing else: the reason of the refusal
 * of the service stays in the log, and what the page shows is escaped.
 */

/** Escapes the text that a page shows. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The titles of the pages of the refusals. */
const TITLES: Record<string, string> = {
  invalid_request: 'The request is not valid',
  login_state_invalid: 'The login has to start again',
  identity_rejected: 'The identity was refused',
  identity_unknown: 'The identity is not known to the platform',
  principal_disabled: 'The account is disabled',
  tenant_disabled: 'The tenant is disabled',
  upstream_unavailable: 'The provider is not reachable',
  internal_error: 'The service failed to answer',
}

/**
 * Builds the page of a refusal of the login.
 *
 * The page names the code of the refusal and says what happened. It never
 * shows the reason of the failure of a dependency.
 */
export function refusalPage(code: string, message: string, status: number): Response {
  const title = TITLES[code] ?? 'The login was refused'
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p><code>${escapeHtml(code)}</code></p>
  </body>
</html>
`
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
