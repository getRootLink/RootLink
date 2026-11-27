import { archiveOwner, databaseHeaders, prepareArchiveRequest } from '../lib/archive-auth.js';

export default async function handler(req, res) {
  if (!prepareArchiveRequest(req, res)) return;
  try {
    const owner = await archiveOwner(req, res);
    if (!owner) return;
    const data = req.body?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Invalid archive data' });
    }
    // Append snapshots: user_id has no unique constraint in the legacy schema.
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/archives`, {
      method: 'POST',
      headers: { ...databaseHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: owner, data }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return res.status(502).json({ error: 'Archive save failed' });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(503).json({ error: 'Archive service unavailable' });
  }
}
