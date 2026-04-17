/**
 * Secure proxy for Google Gemini API.
 * GET /api/claude -> lists available Gemini models
 * POST /api/claude -> proxies generateContent with model fallback
 */

// Try models in order; skip to next on any error (503=overload, 404=unavailable, etc.)
const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function toGeminiContents(messages) {
  return messages.map(msg => {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof msg.content === 'string') {
      parts = [{ text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      parts = msg.content.map(block => {
        if (block.type === 'text') return { text: block.text };
        if (block.type === 'document' && block.source?.type === 'base64') {
          return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
        }
        if (block.type === 'image' && block.source?.type === 'base64') {
          return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
        }
        return null;
      }).filter(Boolean);
    } else {
      parts = [{ text: '' }];
    }
    return { role, parts };
  });
}

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (req.method === 'GET') {
    const r = await fetch(`${GEMINI_BASE}/models?key=${apiKey}`);
    const d = await r.json();
    return res.status(r.status).json(d);
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    const usesWebSearch = Array.isArray(body?.tools) && body.tools.length > 0;
    const geminiBody = {
      contents: toGeminiContents(body.messages || []),
      generationConfig: { maxOutputTokens: body.max_tokens || 8192 },
    };
    if (body.system) {
      geminiBody.systemInstruction = { parts: [{ text: body.system }] };
    }
    if (usesWebSearch) {
      geminiBody.tools = [{ google_search: {} }];
    }

    let response, data, usedModel;

    // Try each model; move to next on any non-200 response
    for (const model of GEMINI_MODELS) {
      response = await fetch(
        `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
      );
      data = await response.json();
      if (response.ok) { usedModel = model; break; }
      // Retry once on 503 (overload) before trying next model
      if (response.status === 503) {
        await new Promise(r => setTimeout(r, 1500));
        response = await fetch(
          `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
        );
        data = await response.json();
        if (response.ok) { usedModel = model; break; }
      }
      console.warn(`Model ${model} failed (${response.status}), trying next...`);
    }

    if (!response.ok) {
      console.error('All models failed. Last error:', JSON.stringify(data));
      return res.status(response.status).json(data);
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('');
    console.log(`Used model: ${usedModel}, text length: ${text.length}`);
    return res.status(200).json({ content: [{ type: 'text', text }], model: usedModel, role: 'assistant' });
  } catch (err) {
    console.error('Gemini proxy error:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };
