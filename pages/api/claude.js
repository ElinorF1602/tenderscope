/**
 * Secure proxy for Google Gemini API.
 * Accepts Claude-format requests, translates to Gemini, returns Claude-format responses.
 * The API key never leaves the server.
 */

const GEMINI_MODEL = 'gemini-2.5-flash-preview-04-17';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
                            return { text: JSON.stringify(block) };
                  });
          } else {
                  parts = [{ text: String(msg.content) }];
          }
          return { role, parts };
    });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
          return res.status(405).json({ error: 'Method not allowed' });
    }

  try {
        const body = req.body;
        const apiKey = process.env.GOOGLE_API_KEY;

      const usesWebSearch = Array.isArray(body?.tools) && body.tools.length > 0;

      const geminiBody = {
              contents: toGeminiContents(body.messages || []),
              generationConfig: {
                        maxOutputTokens: body.max_tokens || 8192,
              },
      };

      if (body.system) {
              geminiBody.systemInstruction = {
                        parts: [{ text: body.system }],
              };
      }

      if (usesWebSearch) {
              geminiBody.tools = [{ google_search: {} }];
      }

      const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(geminiBody),
      });

      const data = await response.json();

      if (!response.ok) {
              console.error('Gemini error:', JSON.stringify(data));
              return res.status(response.status).json(data);
      }

      const parts = data.candidates?.[0]?.content?.parts || [];
        const text = parts.map(p => p.text || '').join('');

      return res.status(200).json({
              content: [{ type: 'text', text }],
              model: GEMINI_MODEL,
              role: 'assistant',
      });
  } catch (err) {
        console.error('Gemini proxy error:', err);
        return res.status(500).json({ error: { message: err.message } });
  }
}

export const config = {
    api: {
          bodyParser: {
                  sizeLimit: '20mb',
          },
    },
};
