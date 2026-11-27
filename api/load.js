import { archiveOwner, databaseHeaders, prepareArchiveRequest } from '../lib/archive-auth.js';

export default async function handler(req, res) {
  if (!prepareArchiveRequest(req, res)) return;
  try {
    const owner = await archiveOwner(req, res);
    if (!owner) return;
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/archives`);
    // Quote PostgREST values too: email addresses may contain filter punctuation.
    const quotedOwner = owner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    url.searchParams.set('user_id', `eq."${quotedOwner}"`);
    url.searchParams.set('select', 'data');
    url.searchParams.set('order', 'created_at.desc,id.desc');
    url.searchParams.set('limit', '1');
    const response = await fetch(url, {
      headers: databaseHeaders(),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return res.status(502).json({ error: 'Archive load failed' });
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid archive response');
    return res.status(200).json({ data: rows[0]?.data ?? null });
  } catch {
    return res.status(503).json({ error: 'Archive service unavailable' });
  }
}
