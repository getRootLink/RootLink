export function prepareArchiveRequest(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return false;
  }
  return true;
}

export function databaseHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
  };
}

export async function archiveOwner(req, res) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) {
    res.status(401).json({ error: 'Sign in required' });
    return null;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    res.status(503).json({ error: 'Archive service unavailable' });
    return null;
  }
  // Validate with this project's Auth server; never trust unverified JWT claims.
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { ...databaseHeaders(), Authorization: `Bearer ${match[1]}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    res.status(response.status === 401 || response.status === 403 ? 401 : 503)
      .json({ error: 'Unable to verify sign in' });
    return null;
  }
  const user = await response.json();
  if (!user.id || !user.email || !user.email_confirmed_at) {
    res.status(403).json({ error: 'Verified email required' });
    return null;
  }
  // Preserve the legacy email mapping until archives are migrated to UUID owners.
  if (req.body?.user_id !== undefined && req.body.user_id !== user.email) {
    res.status(403).json({ error: 'Archive owner mismatch' });
    return null;
  }
  return user.email;
}
