const config = require("../config");
const db = require("../db");

const { chunkText } = require("./chunker");
const ollama = require("./ollama");
const { fetchWebSources } = require("./webSources");

const {
  cosineSimilarity,
  keywordSimilarity,
  phraseSimilarity,
  matchingPhrases,
  matchingWordCount,
  combinedScore,
} = require("./similarity");

function levelFor(percent) {
  return config.levels.find((l) => percent >= l.min).label;
}

/**
 * Load studies stored locally in MySQL.
 */
async function loadLocalStudies() {
  const rows = await db.query(
    "SELECT id, title, authors, year, url, content FROM studies ORDER BY id",
  );

  return rows.map((r) => ({
    provider: "database",
    sourceType: "local",
    refId: r.id,
    title: r.title,
    authors: r.authors,
    url: r.url,
    content: r.content,
  }));
}

/**
 * Remove obvious references from a document.
 */
function removeReferenceSection(text) {
  const patterns = [
    /\n\s*references\s*\n/i,
    /\n\s*bibliography\s*\n/i,
    /\n\s*works cited\s*\n/i,
    /\n\s*literature cited\s*\n/i,
  ];

  let position = -1;

  for (const pattern of patterns) {
    const match = pattern.exec(text);

    if (match && (position === -1 || match.index < position)) {
      position = match.index;
    }
  }

  return position >= 0
    ? text.slice(0, position).trim()
    : text.trim();
}

/**
 * Detects common academic citation formats.
 */
function hasCitation(text) {
  if (!text) return false;

  const patterns = [
    /\([A-Z][A-Za-z'’-]+(?:\s+et\s+al\.)?,?\s*(?:19|20)\d{2}[a-z]?\)/i,

    /\([A-Z][A-Za-z'’-]+(?:\s*&\s*[A-Z][A-Za-z'’-]+)?,?\s*(?:19|20)\d{2}[a-z]?\)/i,

    /\b[A-Z][A-Za-z'’-]+\s+et\s+al\.\s*\(\s*(?:19|20)\d{2}[a-z]?\s*\)/i,

    /\b[A-Z][A-Za-z'’-]+\s+(?:and|&)\s+[A-Z][A-Za-z'’-]+\s*\(\s*(?:19|20)\d{2}[a-z]?\s*\)/i,

    /\[[0-9]{1,3}(?:\s*[,;-]\s*[0-9]{1,3})*\]/,

    /\(\s*(?:19|20)\d{2}\s*:\s*\d+\s*\)/,
  ];

  return patterns.some((p) => p.test(text));
}

/**
 * Detect quotation marks.
 */
function hasQuotation(text) {
  if (!text) return false;

  const quoteMatches = [
    /"[^"]{20,}"/,
    /“[^”]{20,}”/,
    /‘[^’]{20,}’/,
    /'[^']{20,}'/,
  ];

  return quoteMatches.some((p) => p.test(text));
}

/**
 * Determines whether a section appears properly attributed.
 *
 * We intentionally require attribution/citation rather than
 * treating every quotation as automatically acceptable.
 */
function isAttributed(text) {
  if (!text) return false;

  const citation = hasCitation(text);
  const quotation = hasQuotation(text);

  return citation || quotation;
}

/**
 * Split text into sentences.
 */
function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Estimate how much of a chunk is attributed.
 *
 * This prevents a whole 120-word chunk from being thrown away
 * simply because it contains one citation.
 */
function attributionStats(text) {
  const sentences = splitSentences(text);

  if (!sentences.length) {
    return {
      totalWords: text.split(/\s+/).filter(Boolean).length,
      attributedWords: 0,
      eligibleWords: text.split(/\s+/).filter(Boolean).length,
    };
  }

  let totalWords = 0;
  let attributedWords = 0;

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    totalWords += words.length;

    if (isAttributed(sentence)) {
      attributedWords += words.length;
    }
  }

  return {
    totalWords,
    attributedWords,
    eligibleWords: Math.max(0, totalWords - attributedWords),
  };
}

/**
 * Pre-filter candidates.
 */
function prefilter(sources, documentText, limit) {
  return sources
    .map((s) => ({
      ...s,
      prescore: keywordSimilarity(
        documentText,
        s.content || "",
      ),
    }))
    .filter((s) => s.prescore > 0.005)
    .sort((a, b) => b.prescore - a.prescore)
    .slice(0, limit);
}

/**
 * Full similarity + uncited-content plagiarism scan.
 */
async function runScan(
  { scanId, fileId, text },
  onProgress = () => {},
) {
  const started = Date.now();

  const {
    chunkWords,
    chunkOverlapWords,
    maxChunks,
    matchThreshold,
    topCandidateSources,
    plagiarismThreshold,
  } = config.scan;

  /*
   * IMPORTANT:
   * References are not plagiarism evidence.
   */
  const analysisText = removeReferenceSection(text);

  onProgress("Splitting the study into sections");

  const chunks = chunkText(analysisText, {
    chunkWords,
    overlapWords: chunkOverlapWords,
    maxChunks,
  });

  onProgress("Loading studies from the database");

  const local = await loadLocalStudies();

  let web = [];

  try {
    web = await fetchWebSources(
      analysisText,
      onProgress,
    );
  } catch (e) {
    onProgress(
      `Online source lookup skipped: ${e.message}`,
    );
  }

  onProgress("Pre-filtering candidate sources");

  const candidates = prefilter(
    [...local, ...web],
    analysisText,
    topCandidateSources,
  );

  const useEmbeddings = await ollama.isAvailable();

  onProgress(
    useEmbeddings
      ? "Generating embeddings with Ollama"
      : "Ollama unavailable - using keyword and phrase matching only",
  );

  let uploadVectors = [];

  const sourceChunkMap = new Map();

  if (useEmbeddings) {
    uploadVectors = await ollama.embedMany(
      chunks.map((c) => c.text),
    );

    for (const [i, src] of candidates.entries()) {
      onProgress(
        `Comparing against source ${i + 1}/${candidates.length}`,
      );

      const sChunks = chunkText(
        src.content || "",
        {
          chunkWords,
          overlapWords: chunkOverlapWords,
          maxChunks: 100,
        },
      );

      const vectors = await ollama.embedMany(
        sChunks.map((c) => c.text),
      );

      sourceChunkMap.set(
        src,
        sChunks.map((c, j) => ({
          ...c,
          vector: vectors[j],
        })),
      );
    }
  } else {
    for (const src of candidates) {
      const sChunks = chunkText(
        src.content || "",
        {
          chunkWords,
          overlapWords: chunkOverlapWords,
          maxChunks: 100,
        },
      );

      sourceChunkMap.set(
        src,
        sChunks.map((c) => ({
          ...c,
          vector: null,
        })),
      );
    }
  }

  onProgress("Scoring matching sections");

  const perSource = new Map();

  const bestPerChunk = new Array(
    chunks.length,
  ).fill(0);

  let eligibleWords = 0;
  let attributedWords = 0;

  /*
   * Calculate the amount of paper content that is
   * eligible for plagiarism assessment.
   */
  for (const chunk of chunks) {
    const stats = attributionStats(chunk.text);

    eligibleWords += stats.eligibleWords;
    attributedWords += stats.attributedWords;
  }

  /*
   * Prevent overlap between chunks from inflating the
   * document denominator too severely.
   */
  const estimatedDocumentWords =
    analysisText.split(/\s+/).filter(Boolean).length;

  const attributedRatio =
    estimatedDocumentWords > 0
      ? attributedWords / estimatedDocumentWords
      : 0;

  eligibleWords = Math.max(
    1,
    Math.round(
      estimatedDocumentWords *
        Math.max(0, 1 - attributedRatio),
    ),
  );

  /*
   * Compare every upload chunk against every candidate.
   */
  for (const [ci, chunk] of chunks.entries()) {
    const attribution = attributionStats(
      chunk.text,
    );

    for (const src of candidates) {
      const sChunks =
        sourceChunkMap.get(src) || [];

      let best = {
        score: 0,
        sourceText: null,
        phrase: 0,
        keyword: 0,
        embedding: 0,
      };

      for (const sc of sChunks) {
        const embedding =
          useEmbeddings &&
          sc.vector
            ? Math.max(
                0,
                cosineSimilarity(
                  uploadVectors[ci],
                  sc.vector,
                ),
              )
            : 0;

        const phrase = phraseSimilarity(
          chunk.text,
          sc.text,
        );

        const keyword = keywordSimilarity(
          chunk.text,
          sc.text,
        );

        const score = combinedScore({
          embedding,
          phrase,
          keyword,
        });

        if (score > best.score) {
          best = {
            score,
            sourceText: sc.text,
            phrase,
            keyword,
            embedding,
          };
        }
      }

      if (best.score >= matchThreshold) {
        if (!perSource.has(src)) {
          perSource.set(src, {
            matched: new Set(),
            sections: [],
            sum: 0,
            uncitedWords: 0,
          });
        }

        const entry = perSource.get(src);

        entry.matched.add(ci);
        entry.sum += best.score;

        /*
         * Count exact shared wording.
         */
        const exactWords =
          matchingWordCount(
            chunk.text,
            best.sourceText || "",
            { n: 5 },
          );

        /*
         * Only count matching material as plagiarism
         * when it is not attributed.
         *
         * If the section contains a citation, we reduce
         * the count by the attributed portion.
         */
        let uncitedMatchWords =
          exactWords;

        if (attribution.totalWords > 0) {
          const attributedRatio =
            attribution.attributedWords /
            attribution.totalWords;

          uncitedMatchWords = Math.round(
            exactWords *
              Math.max(
                0,
                1 - attributedRatio,
              ),
          );
        }

        /*
         * Strong semantic matches without exact phrase
         * overlap still count, but use the eligible
         * portion of the chunk.
         */
        if (
          uncitedMatchWords === 0 &&
          best.score >= matchThreshold &&
          best.phrase >= 0.20
        ) {
          uncitedMatchWords = Math.round(
            attribution.eligibleWords *
              best.score,
          );
        }

        entry.uncitedWords +=
          uncitedMatchWords;

        entry.sections.push({
          chunkIndex: ci,

          uploadedText: chunk.text,

          sourceText:
            best.sourceText,

          similarity:
            Math.round(
              best.score * 10000,
            ) / 100,

          phrases:
            matchingPhrases(
              chunk.text,
              best.sourceText || "",
            ),

          cited:
            attribution.attributedWords > 0,

          attributedWords:
            attribution.attributedWords,

          eligibleWords:
            attribution.eligibleWords,

          matchedWords:
            exactWords,

          uncitedMatchedWords:
            uncitedMatchWords,

          status:
            uncitedMatchWords > 0
              ? "potentially_plagiarized"
              : "properly_attributed",
        });

        if (
          best.score >
          bestPerChunk[ci]
        ) {
          bestPerChunk[ci] =
            best.score;
        }
      }
    }
  }

  /*
   * Overall source similarity is retained for information,
   * but it is NOT the plagiarism decision.
   */
  const overallSimilarity =
    chunks.length
      ? bestPerChunk.reduce(
          (a, b) => a + b,
          0,
        ) / chunks.length
      : 0;

  const similarityPercent =
    Math.min(
      100,
      Math.round(
        overallSimilarity * 10000,
      ) / 100,
    );

  /*
   * Calculate actual uncited matching percentage.
   */
  let uncitedMatchingWords = 0;

  for (const entry of perSource.values()) {
    uncitedMatchingWords +=
      entry.uncitedWords;
  }

  /*
   * A word can match multiple sources.
   * Cap the final count to the eligible paper size.
   */
  uncitedMatchingWords = Math.min(
    eligibleWords,
    uncitedMatchingWords,
  );

  const uncitedMatchingPercent =
    eligibleWords > 0
      ? Math.min(
          100,
          Math.round(
            (uncitedMatchingWords /
              eligibleWords) *
              10000,
          ) / 100,
        )
      : 0;

  /*
   * THIS is your 40% rule.
   */
  const likelyPlagiarism =
    uncitedMatchingPercent >=
    plagiarismThreshold;

  const similarityLevel =
    levelFor(similarityPercent);

  /*
   * Persist matched sources.
   */
  const sourceRows = [];

  for (const [
    src,
    entry,
  ] of perSource) {
    const pct =
      chunks.length > 0
        ? Math.round(
            (entry.sum /
              chunks.length) *
              10000,
          ) / 100
        : 0;

    const sourceId =
      await db.insert(
        `INSERT INTO scan_matched_sources
          (scan_id, source_type, source_ref_id, title, authors, url, provider, similarity_percent, matched_chunks)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          scanId,
          src.sourceType,
          src.refId || null,
          String(
            src.title ||
              "Untitled source",
          ).slice(0, 760),
          src.authors
            ? String(
                src.authors,
              ).slice(0, 760)
            : null,
          src.url
            ? String(
                src.url,
              ).slice(0, 1020)
            : null,
          src.provider,
          Math.min(
            100,
            pct,
          ),
          entry.matched.size,
        ],
      );

    for (const sec of entry.sections) {
      await db.insert(
        `INSERT INTO scan_matched_sections
          (scan_id, matched_source_id, chunk_index, uploaded_text, source_text, similarity_percent, matched_phrases)
         VALUES (?,?,?,?,?,?,?)`,
        [
          scanId,
          sourceId,
          sec.chunkIndex,
          sec.uploadedText.slice(
            0,
            4000,
          ),
          (
            sec.sourceText ||
            ""
          ).slice(0, 4000),
          sec.similarity,
          sec.phrases
            .join(" | ")
            .slice(0, 4000),
        ],
      );
    }

    sourceRows.push({
      id: sourceId,

      sourceType:
        src.sourceType,

      title: src.title,

      authors:
        src.authors || null,

      url:
        src.url || null,

      provider:
        src.provider,

      similarityPercent:
        Math.min(
          100,
          pct,
        ),

      matchedChunks:
        entry.matched.size,

      uncitedMatchedWords:
        entry.uncitedWords,

      sections:
        entry.sections,
    });
  }

  sourceRows.sort(
    (a, b) =>
      b.similarityPercent -
      a.similarityPercent,
  );

  const matchedChunks =
    bestPerChunk.filter(
      (s) => s > 0,
    ).length;

  const durationMs =
    Date.now() - started;

  await db.query(
    `UPDATE scans
       SET status='completed',
           similarity_percent=?,
           similarity_level=?,
           total_chunks=?,
           matched_chunks=?,
           sources_compared=?,
           duration_ms=?,
           completed_at=NOW()
     WHERE id=?`,
    [
      similarityPercent,
      likelyPlagiarism
        ? "Likely Plagiarism"
        : "Predominantly Original",
      chunks.length,
      matchedChunks,
      candidates.length,
      durationMs,
      scanId,
    ],
  );

  /*
   * Always return matching sources when there are
   * meaningful matches. Do not hide them just because
   * the overall percentage is below 20%.
   */
  return {
    scanId,
    fileId,

    /*
     * Keep old field for frontend compatibility.
     */
    similarityPercent,

    similarityLevel,

    /*
     * New plagiarism-specific result.
     */
    plagiarismPercent:
      uncitedMatchingPercent,

    uncitedMatchingPercent,

    uncitedMatchingWords,

    eligibleWords,

    attributedWords,

    plagiarismThreshold,

    likelyPlagiarism,

    verdict:
      likelyPlagiarism
        ? "Likely Plagiarism"
        : "Predominantly Original",

    detailed: true,

    totalChunks:
      chunks.length,

    matchedChunks,

    sourcesCompared:
      candidates.length,

    embeddingsUsed:
      useEmbeddings,

    durationMs,

    referencesExcluded: true,

    sources: sourceRows,

    matchedSections:
      sourceRows.flatMap(
        (s) =>
          s.sections.map(
            (sec) => ({
              ...sec,
              sourceTitle:
                s.title,
              sourceAuthors:
                s.authors,
              sourceUrl:
                s.url,
              provider:
                s.provider,
            }),
          ),
      ),
  };
}

module.exports = {
  runScan,
  levelFor,
};