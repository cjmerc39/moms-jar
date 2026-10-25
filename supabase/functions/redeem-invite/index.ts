// @ts-nocheck
// redeem-invite: swaps an invite link's key (or its backup code) for a
// sign-in on this device. Deployed to Supabase as an Edge Function with
// "Verify JWT" turned off, since callers aren't signed in yet.
//
// Each successful swap creates a new account just for this device, maps it to
// the person (public.link_device), and returns a one-time token the app
// exchanges for a session at /auth/v1/verify. Nothing secret is logged.
//
// Plain JavaScript inside a .ts file, so it also runs under Node for tests.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const NOT_WORKING = "That key or code isn't working. Ask CJ for a new link.";
const TRY_AGAIN = 'Something went wrong. Try again in a minute.';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export function deviceKind(userAgent) {
  const ua = userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Other';
}

// env: { url, secretKey }
export async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Not allowed.' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Paste your key or type your backup code.' }, 400);
  }
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!key && !code) return json({ error: 'Paste your key or type your backup code.' }, 400);
  if (key.length > 100 || code.length > 30) return json({ error: NOT_WORKING }, 401);

  if (!env.url || !env.secretKey) return json({ error: TRY_AGAIN }, 500);
  // New secret keys go in the apikey header alone; a legacy service_role key also needs Authorization.
  const headers = {
    apikey: env.secretKey,
    'Content-Type': 'application/json',
    ...(env.secretKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${env.secretKey}` }),
  };
  const call = async (method, path, payload) => {
    const r = await fetch(`${env.url}${path}`, { method, headers, body: JSON.stringify(payload) });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };

  const check = await call('POST', '/rest/v1/rpc/redeem_invite', { p_key: key || null, p_code: key ? null : code });
  if (check.status !== 200) {
    const message = check.data?.message || '';
    if (message.startsWith('Too many tries')) return json({ error: message }, 429);
    return json({ error: TRY_AGAIN }, 500);
  }
  const hit = Array.isArray(check.data) ? check.data[0] : null;
  if (!hit) return json({ error: NOT_WORKING }, 401);

  const email = `device-${crypto.randomUUID()}@devices.moms-jar.invalid`;
  const user = await call('POST', '/auth/v1/admin/users', { email, email_confirm: true });
  if (user.status >= 300 || !user.data?.id) return json({ error: TRY_AGAIN }, 502);

  const linked = await call('POST', '/rest/v1/rpc/link_device', {
    p_user: user.data.id,
    p_person: hit.person_id,
    p_invite: hit.invite_id,
    p_device: deviceKind(req.headers.get('user-agent')),
  });
  const link = linked.status < 300
    ? await call('POST', '/auth/v1/admin/generate_link', { type: 'magiclink', email })
    : null;
  if (!link || link.status >= 300 || !link.data?.hashed_token) {
    await call('DELETE', `/auth/v1/admin/users/${user.data.id}`);
    return json({ error: TRY_AGAIN }, 502);
  }

  return json({ token_hash: link.data.hashed_token, type: 'magiclink' });
}

// Inside Supabase: read the project's own URL and secret key from its environment.
if (typeof Deno !== 'undefined') {
  const secrets = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
  const env = {
    url: Deno.env.get('SUPABASE_URL'),
    secretKey: Object.values(secrets)[0] || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  };
  Deno.serve((req) => handle(req, env));
}
