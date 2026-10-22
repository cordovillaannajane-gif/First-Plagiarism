require("dotenv").config();

const num = (v, d) =>
  v === undefined || v === "" || Number.isNaN(Number(v))
    ? d
    : Number(v);

const bool = (v, d) =>
  v === undefined ? d : String(v).toLowerCase() === "true";

module.exports = {
  port: num(process.env.PORT, 3000),

  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "plagiarism_db",
  },

  ollama: {
    url: (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(
      /\/$/,
      "",
    ),
    embedModel:
      process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",
  },

  scan: {
    maxUploadBytes:
      num(process.env.MAX_UPLOAD_MB, 40) * 1024 * 1024,

    chunkWords: num(process.env.CHUNK_WORDS, 120),

    chunkOverlapWords:
      num(process.env.CHUNK_OVERLAP_WORDS, 25),

    maxChunks: num(process.env.MAX_CHUNKS, 400),

    /*
     * A source section must reach this similarity
     * before it is considered a substantial match.
     */
    matchThreshold:
      num(process.env.MATCH_THRESHOLD, 0.80),

    topCandidateSources:
      num(process.env.TOP_CANDIDATE_SOURCES, 50),

    /*
     * Main plagiarism decision.
     *
     * This is NOT the source similarity threshold.
     * It is the percentage of eligible paper content
     * that is uncited and substantially matched.
     */
    plagiarismThreshold:
      num(process.env.PLAGIARISM_THRESHOLD, 40),

    /*
     * Minimum phrase overlap used as strong evidence.
     */
    strongPhraseThreshold:
      num(process.env.STRONG_PHRASE_THRESHOLD, 0.35),
  },

  web: {
    enabled: bool(process.env.ENABLE_WEB_SOURCES, true),

    mailto:
      process.env.CROSSREF_MAILTO ||
      "anonymous@example.com",

    /*
     * More targeted queries, but fewer results per request.
     */
    queries: num(process.env.WEB_QUERIES, 8),

    resultsPerQuery:
      num(process.env.WEB_RESULTS_PER_QUERY, 10),

    /*
     * Network settings.
     */
    timeoutMs:
      num(process.env.WEB_TIMEOUT_MS, 20000),

    arxivTimeoutMs:
      num(process.env.ARXIV_TIMEOUT_MS, 30000),

    semanticScholarDelayMs:
      num(process.env.S2_DELAY_MS, 1200),
  },

  levels: [
    {
      min: 75,
      label: "Very High Similarity",
    },
    {
      min: 50,
      label: "High Similarity",
    },
    {
      min: 20,
      label: "Moderate Similarity",
    },
    {
      min: 0,
      label: "Low/No Significant Similarity",
    },
  ],

  reportThreshold: 20,
};