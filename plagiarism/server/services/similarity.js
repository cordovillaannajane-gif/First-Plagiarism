const { contentWords, tokenize } = require("./chunker");

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  if (!na || !nb) return 0;

  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Keyword overlap.
 */
function keywordSimilarity(textA, textB) {
  const a = new Set(contentWords(textA));
  const b = new Set(contentWords(textB));

  if (!a.size || !b.size) return 0;

  let inter = 0;

  for (const w of a) {
    if (b.has(w)) inter++;
  }

  return inter / (a.size + b.size - inter);
}

function ngrams(tokens, n) {
  const out = new Set();

  for (let i = 0; i + n <= tokens.length; i++) {
    out.add(tokens.slice(i, i + n).join(" "));
  }

  return out;
}

/**
 * Phrase similarity.
 *
 * Multiple phrase lengths help detect both copied sentences
 * and longer copied passages.
 */
function phraseSimilarity(textA, textB) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);

  if (!tokensA.length || !tokensB.length) return 0;

  const sizes = [4, 5, 7, 9];

  let best = 0;

  for (const n of sizes) {
    const a = ngrams(tokensA, n);
    const b = ngrams(tokensB, n);

    if (!a.size || !b.size) continue;

    let inter = 0;

    for (const gram of a) {
      if (b.has(gram)) inter++;
    }

    best = Math.max(best, inter / a.size);
  }

  return best;
}

/**
 * Counts words participating in exact shared phrases.
 */
function matchingWordCount(textA, textB, { n = 5 } = {}) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);

  if (!tokensA.length || !tokensB.length) return 0;

  const setB = ngrams(tokensB, n);

  let count = 0;
  let i = 0;

  while (i + n <= tokensA.length) {
    const gram = tokensA.slice(i, i + n).join(" ");

    if (!setB.has(gram)) {
      i++;
      continue;
    }

    let end = i + n;

    while (end < tokensA.length) {
      const nextGram = tokensA
        .slice(end - n + 1, end + 1)
        .join(" ");

      if (!setB.has(nextGram)) break;

      end++;
    }

    count += end - i;
    i = end;
  }

  return count;
}

/**
 * Finds long shared phrases.
 */
function matchingPhrases(textA, textB, { n = 5, limit = 8 } = {}) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);

  if (!tokensA.length || !tokensB.length) return [];

  const setB = ngrams(tokensB, n);
  const found = [];

  let i = 0;

  while (i + n <= tokensA.length) {
    const gram = tokensA.slice(i, i + n).join(" ");

    if (!setB.has(gram)) {
      i++;
      continue;
    }

    let end = i + n;

    while (end < tokensA.length) {
      const nextGram = tokensA
        .slice(end - n + 1, end + 1)
        .join(" ");

      if (!setB.has(nextGram)) break;

      end++;
    }

    found.push(tokensA.slice(i, end).join(" "));
    i = end;
  }

  return found
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);
}

/**
 * Combined similarity score.
 *
 * Exact wording is deliberately important.
 */
function combinedScore({
  embedding = 0,
  phrase = 0,
  keyword = 0,
}) {
  const weighted =
    0.50 * embedding +
    0.40 * phrase +
    0.10 * keyword;

  /*
   * Strong exact phrase overlap is evidence even when
   * semantic embeddings are weaker.
   */
  if (phrase >= 0.35) {
    return Math.max(weighted, phrase);
  }

  return weighted;
}

module.exports = {
  cosineSimilarity,
  keywordSimilarity,
  phraseSimilarity,
  matchingWordCount,
  matchingPhrases,
  combinedScore,
};