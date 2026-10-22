const config = require("../config");

/**
 * Thin client for the local Ollama embeddings API.
 * Ollama is used ONLY for semantic similarity (embeddings) - never to judge
 * whether text is AI-generated.
 */

let availability = null;

async function isAvailable() {
  if (availability !== null) return availability;
  try {
    const res = await fetch(`${config.ollama.url}/api/tags`, { signal: AbortSignal.timeout(4000) });
    availability = res.ok;
  } catch {
    availability = false;
  }
  return availability;
}

async function embedOne(text) {
  const res = await fetch(`${config.ollama.url}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.ollama.embedModel, prompt: text.slice(0, 8000) }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embeddings failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error("Ollama returned no embedding vector.");
  return data.embedding;
}

/**
 * Embeds texts with a small concurrency window so large PDFs stay fast
 * without overloading the local model.
 */
async function embedMany(texts, { concurrency = 4 } = {}) {
  const out = new Array(texts.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, texts.length) }, async () => {
    while (cursor < texts.length) {
      const i = cursor++;
      out[i] = await embedOne(texts[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { isAvailable, embedOne, embedMany };
