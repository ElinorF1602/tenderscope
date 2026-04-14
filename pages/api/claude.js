/**
 * Secure proxy for Anthropic API.
 * The API key never leaves the server — the browser only calls /api/claude.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    const usesWebSearch = Array.isArray(body?.tools) && body.tools.some(t => t.type === 'web_search_20250305');
    const headers = { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
    if (usesWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';
    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };
