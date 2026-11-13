/**
 * The few pages a person ever sees: consent and errors. Plain server-rendered HTML, no scripts,
 * so a strict Content-Security-Policy applies (see app.ts).
 */

const escape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
  main { max-width: 28rem; width: 100%; }
  h1 { font-size: 1.3rem; }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .6rem 1.2rem; border-radius: .4rem; border: 1px solid; cursor: pointer; }
  button[value="true"] { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  code { overflow-wrap: anywhere; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export interface ConsentPageInput {
  clientName: string;
  resource: string | null;
  /** The signed authorization request, posted back unchanged. */
  oauthQuery: string;
}

export function consentPage({ clientName, resource, oauthQuery }: ConsentPageInput): string {
  return layout(
    'Allow access?',
    `<h1>Allow <strong>${escape(clientName)}</strong> to act on your behalf?</h1>
<p>It will be able to use ${
      resource ? `<code>${escape(resource)}</code>` : 'the requested service'
    } as you until you revoke access.</p>
<form method="post">
  <input type="hidden" name="oauth_query" value="${escape(oauthQuery)}">
  <div class="actions">
    <button type="submit" name="accept" value="true">Allow</button>
    <button type="submit" name="accept" value="false">Deny</button>
  </div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return layout('Sign-in failed', `<h1>Sign-in failed</h1><p>${escape(message)}</p>`);
}
