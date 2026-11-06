// Making a Kea Hub account in tests the way Kea does (electron/hub.cjs hub:register): the Hub answers the same whether
// or not the email was taken and never signs in by itself, so Kea signs in right after. Resolves with the sign-in's
// Response ({ token, account } as JSON), or the register Response if that failed.
export async function registerAndSignIn(base, init) {
  const { email, password } = JSON.parse(init.body);
  const r = await fetch(`${base}/v1/auth/register`, init);
  if (r.status !== 202) return r;
  return fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
}
