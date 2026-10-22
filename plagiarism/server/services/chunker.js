/**
 * Splits a document into meaningful, overlapping sections for comparison.
 * Sections respect paragraph and sentence boundaries where possible.
 */

const STOP_WORDS = new Set(
  ("a,an,and,are,as,at,be,been,but,by,for,from,had,has,have,in,into,is,it,its,of,on,or,that,the," +
    "their,there,these,this,to,was,were,which,while,with,within,also,such,than,then,they,we,our," +
    "study,studies,research,paper,using,used,use,based,results,result,data,between,can,may,more,most")
    .split(","),
);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((t) => t.length > 2);
}

function contentWords(text) {
  return tokenize(text).filter((t) => !STOP_WORDS.has(t));
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @returns {{index:number, text:string, words:number}[]}
 */
function chunkText(text, { chunkWords = 120, overlapWords = 25, maxChunks = 400 } = {}) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  const units = [];
  for (const p of paragraphs) units.push(...splitSentences(p));

  const chunks = [];
  let buffer = [];
  let bufferWords = 0;

  const flush = () => {
    if (!buffer.length) return;
    const textChunk = buffer.join(" ").trim();
    if (textChunk.split(/\s+/).length >= 25) {
      chunks.push({ index: chunks.length, text: textChunk, words: textChunk.split(/\s+/).length });
    }
    // carry overlap
    const carry = [];
    let carryWords = 0;
    for (let i = buffer.length - 1; i >= 0 && carryWords < overlapWords; i--) {
      carry.unshift(buffer[i]);
      carryWords += buffer[i].split(/\s+/).length;
    }
    buffer = carry;
    bufferWords = carryWords;
  };

  for (const unit of units) {
    const w = unit.split(/\s+/).length;
    buffer.push(unit);
    bufferWords += w;
    if (bufferWords >= chunkWords) flush();
    if (chunks.length >= maxChunks) break;
  }
  if (chunks.length < maxChunks) {
    const last = buffer.join(" ").trim();
    if (last.split(/\s+/).length >= 25) {
      chunks.push({ index: chunks.length, text: last, words: last.split(/\s+/).length });
    }
  }

  // Large documents: evenly sample chunks so scans stay fast without losing coverage.
  if (chunks.length > maxChunks) {
    const step = chunks.length / maxChunks;
    const sampled = [];
    for (let i = 0; i < maxChunks; i++) sampled.push(chunks[Math.floor(i * step)]);
    return sampled.map((c, i) => ({ ...c, index: i }));
  }
  return chunks;
}

module.exports = { chunkText, tokenize, contentWords, splitSentences, STOP_WORDS };
