const config = require("../config");
const { contentWords, tokenize } = require("./chunker");

/**
 * Web source discovery for plagiarism detection.
 *
 * Providers:
 *   - OpenAlex
 *   - Crossref
 *   - Semantic Scholar
 *   - arXiv
 *   - Europe PMC
 *   - Wikipedia
 *
 * IMPORTANT:
 * These APIs are source-discovery services.
 * They do not provide Turnitin-like access to every published PDF.
 */

const UA = () =>
  `pdf-plagiarism-detector/1.0 (mailto:${
    config.web.mailto || "noreply@example.com"
  })`;

const DEFAULT_RESULTS_PER_QUERY = 15;
const DEFAULT_QUERY_COUNT = 10;
const MIN_CONTENT_LENGTH = 80;

/* ---------------------------------------------------------
 * HTTP helpers
 * --------------------------------------------------------- */

async function getJson(url, timeout = 15000) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": UA(),
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}`);
  }

  return res.json();
}

async function getText(url, timeout = 20000) {
  const res = await fetch(url, {
    headers: {
      accept: "application/xml, application/atom+xml, text/plain, */*",
      "user-agent": UA(),
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}`);
  }

  return res.text();
}

/* ---------------------------------------------------------
 * Text helpers
 * --------------------------------------------------------- */

function clean(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripJats(value) {
  return clean(
    String(value || "")
      .replace(/<jats:[^>]+>/gi, " ")
      .replace(/<\/jats:[^>]+>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function normalizeQuery(value) {
  return clean(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Remove obvious PDF boilerplate from query generation.
 */
function isUsefulSentence(sentence) {
  const s = normalizeQuery(sentence);

  if (s.length < 45) return false;

  const lower = s.toLowerCase();

  const badPatterns = [
    /^academic editor/i,
    /^received:/i,
    /^revised:/i,
    /^accepted:/i,
    /^published:/i,
    /^citation:/i,
    /^doi:/i,
    /^copyright/i,
    /^www\./i,
    /^http/i,
  ];

  if (badPatterns.some((p) => p.test(s))) {
    return false;
  }

  const words = s.split(/\s+/);

  return words.length >= 8;
}

/**
 * Create a compact exact phrase from a sentence.
 *
 * Exact phrases are much better for locating the original
 * publication than frequency-only queries.
 */
function quotePhrase(sentence, maxWords = 18) {
  const words = normalizeQuery(sentence)
    .replace(/[()[\]{}]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 8) return null;

  const selected = words.slice(0, maxWords).join(" ");

  return `"${selected}"`;
}

/**
 * Get several distinctive phrase windows from the document.
 */
function extractPhraseQueries(text, maxQueries) {
  const sourceText = normalizeQuery(text);

  const sentences = sourceText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(isUsefulSentence);

  const queries = [];
  const seen = new Set();

  for (const sentence of sentences) {
    if (queries.length >= maxQueries) break;

    const phrase = quotePhrase(sentence);

    if (!phrase) continue;

    const key = phrase.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    queries.push(phrase);
  }

  return queries;
}

/**
 * Generate distinctive word queries as a fallback.
 */
function extractKeywordQueries(text, maxQueries) {
  const freq = new Map();

  for (const word of contentWords(text)) {
    const w = String(word).toLowerCase().trim();

    if (w.length < 4) continue;

    freq.set(w, (freq.get(w) || 0) + 1);
  }

  const ranked = [...freq.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }

      return a[0].localeCompare(b[0]);
    })
    .map(([word]) => word);

  const queries = [];

  for (
    let i = 0;
    i < ranked.length && queries.length < maxQueries;
    i += 5
  ) {
    const group = ranked.slice(i, i + 7);

    if (group.length >= 4) {
      queries.push(group.join(" "));
    }
  }

  return queries;
}

/**
 * Build high-recall queries.
 *
 * Priority:
 *   1. Exact distinctive sentences
 *   2. Several adjacent phrases
 *   3. Distinctive keyword groups
 */
function buildQueries(text, count = DEFAULT_QUERY_COUNT) {
  const requestedCount = Math.max(
    1,
    Number(count) || DEFAULT_QUERY_COUNT
  );

  const sourceText = normalizeQuery(text);

  if (!sourceText) return [];

  const queries = [];
  const seen = new Set();

  const add = (query) => {
    const q = normalizeQuery(query);

    if (q.length < 20) return;

    const key = q.toLowerCase();

    if (seen.has(key)) return;

    seen.add(key);
    queries.push(q);
  };

  /*
   * Exact sentence searches.
   *
   * These are the most important queries for finding
   * the original publication.
   */
  for (const q of extractPhraseQueries(
    sourceText,
    requestedCount
  )) {
    if (queries.length >= requestedCount) break;

    add(q);
  }

  /*
   * Keyword fallback.
   */
  if (queries.length < requestedCount) {
    for (const q of extractKeywordQueries(
      sourceText,
      requestedCount * 2
    )) {
      if (queries.length >= requestedCount) break;

      add(q);
    }
  }

  /*
   * If there are not enough sentences, generate overlapping
   * word windows from the beginning of the paper.
   */
  if (queries.length < requestedCount) {
    const tokens = tokenize(sourceText);

    for (
      let i = 0;
      i + 12 <= tokens.length &&
      queries.length < requestedCount;
      i += 8
    ) {
      const phrase = tokens.slice(i, i + 18).join(" ");

      if (phrase.length >= 50) {
        add(`"${phrase}"`);
      }
    }
  }

  return queries.slice(0, requestedCount);
}

/* ---------------------------------------------------------
 * OpenAlex
 * --------------------------------------------------------- */

function openAlexAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object") {
    return "";
  }

  const words = [];

  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;

    for (const position of positions) {
      if (Number.isInteger(position)) {
        words[position] = word;
      }
    }
  }

  return clean(words.filter(Boolean).join(" "));
}

async function searchOpenAlex(query, rows) {
  const url =
    `https://api.openalex.org/works` +
    `?search=${encodeURIComponent(query)}` +
    `&per-page=${Math.min(
      Number(rows) || DEFAULT_RESULTS_PER_QUERY,
      100
    )}`;

  const data = await getJson(url);

  return (data?.results || [])
    .map((item) => ({
      provider: "openalex",
      title: item.display_name || "Untitled",
      authors: (item.authorships || [])
        .map((a) => a.author?.display_name)
        .filter(Boolean)
        .join("; "),
      url:
        item.primary_location?.landing_page_url ||
        item.primary_location?.pdf_url ||
        item.doi ||
        null,
      content: openAlexAbstract(item.abstract_inverted_index),
      published: item.publication_date || null,
      doi: item.doi || null,
    }))
    .filter(
      (source) =>
        source.title &&
        (source.content.length >= MIN_CONTENT_LENGTH ||
          source.url)
    );
}

/* ---------------------------------------------------------
 * Crossref
 * --------------------------------------------------------- */

async function searchCrossref(query, rows) {
  const url =
    `https://api.crossref.org/works` +
    `?query.bibliographic=${encodeURIComponent(query)}` +
    `&rows=${Math.min(
      Number(rows) || DEFAULT_RESULTS_PER_QUERY,
      100
    )}` +
    `&select=title,abstract,author,URL,DOI,issued,published` +
    `&mailto=${encodeURIComponent(
      config.web.mailto || ""
    )}`;

  const data = await getJson(url);

  return (data?.message?.items || [])
    .map((item) => ({
      provider: "crossref",
      title: (item.title || [])[0] || "Untitled",
      authors: (item.author || [])
        .map((a) =>
          [a.given, a.family].filter(Boolean).join(" ")
        )
        .filter(Boolean)
        .join("; "),
      url:
        item.URL ||
        (item.DOI
          ? `https://doi.org/${item.DOI}`
          : null),
      content: stripJats(item.abstract || ""),
      published:
        item.issued?.["date-parts"]?.[0]?.join("-") ||
        item.published?.["date-parts"]?.[0]?.join("-") ||
        null,
      doi: item.DOI || null,
    }))
    .filter(
      (source) =>
        source.title &&
        (source.content.length >= MIN_CONTENT_LENGTH ||
          source.url)
    );
}

/* ---------------------------------------------------------
 * Semantic Scholar
 * --------------------------------------------------------- */

async function searchSemanticScholar(query, rows) {
  const url =
    `https://api.semanticscholar.org/graph/v1/paper/search` +
    `?query=${encodeURIComponent(query)}` +
    `&limit=${Math.min(
      Number(rows) || DEFAULT_RESULTS_PER_QUERY,
      100
    )}` +
    `&fields=title,abstract,authors,externalIds,url,year`;

  const data = await getJson(url);

  return (data?.data || [])
    .map((paper) => ({
      provider: "semanticscholar",
      title: paper.title || "Untitled",
      authors: (paper.authors || [])
        .map((a) => a.name)
        .filter(Boolean)
        .join("; "),
      url:
        paper.url ||
        (paper.externalIds?.DOI
          ? `https://doi.org/${paper.externalIds.DOI}`
          : paper.externalIds?.ArXiv
          ? `https://arxiv.org/abs/${paper.externalIds.ArXiv}`
          : null),
      content: clean(paper.abstract || ""),
      published: paper.year || null,
      doi: paper.externalIds?.DOI || null,
    }))
    .filter(
      (source) =>
        source.title &&
        (source.content.length >= MIN_CONTENT_LENGTH ||
          source.url)
    );
}

/* ---------------------------------------------------------
 * arXiv
 * --------------------------------------------------------- */

function pickXml(xml, tag) {
  const match = xml.match(
    new RegExp(
      `<${tag}[^>]*>([\\s\\S]*?)</${tag}>`,
      "i"
    )
  );

  return match ? clean(match[1]) : "";
}

async function searchArxiv(query, rows) {
  const url =
    `https://export.arxiv.org/api/query` +
    `?search_query=all:${encodeURIComponent(query)}` +
    `&start=0` +
    `&max_results=${Math.min(
      Number(rows) || DEFAULT_RESULTS_PER_QUERY,
      100
    )}`;

  const xml = await getText(url, 25000);

  const entries = xml.split("<entry>").slice(1);

  return entries
    .map((entry) => ({
      provider: "arxiv",
      title: pickXml(entry, "title"),
      authors: [
        ...entry.matchAll(
          /<name>([\s\S]*?)<\/name>/gi
        ),
      ]
        .map((m) => clean(m[1]))
        .filter(Boolean)
        .join("; "),
      url:
        (
          entry.match(
            /<id>([\s\S]*?)<\/id>/i
          ) || []
        )[1]?.trim() || null,
      content: pickXml(entry, "summary"),
      published: pickXml(entry, "published") || null,
    }))
    .filter(
      (source) =>
        source.title &&
        source.content.length >= MIN_CONTENT_LENGTH
    );
}

/* ---------------------------------------------------------
 * Europe PMC
 * --------------------------------------------------------- */

async function searchEuropePmc(query, rows) {
  const url =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search` +
    `?query=${encodeURIComponent(query)}` +
    `&format=json` +
    `&pageSize=${Math.min(
      Number(rows) || DEFAULT_RESULTS_PER_QUERY,
      100
    )}` +
    `&resultType=core`;

  const data = await getJson(url);

  return (data?.resultList?.result || [])
    .map((item) => {
      let sourceUrl = null;

      if (
        item.fullTextUrlList?.fullTextUrl?.length
      ) {
        sourceUrl =
          item.fullTextUrlList.fullTextUrl[0].url;
      }

      if (!sourceUrl && item.pmid) {
        sourceUrl =
          `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/`;
      }

      if (!sourceUrl && item.doi) {
        sourceUrl = `https://doi.org/${item.doi}`;
      }

      return {
        provider: "europepmc",
        title: clean(item.title || "Untitled"),
        authors: clean(
          item.authorString ||
            (item.authorList?.author || [])
              .map((a) => a.fullName)
              .join("; ")
        ),
        url: sourceUrl,
        content: clean(
          item.abstractText ||
            item.abstractTextList?.abstractText?.join(
              " "
            ) ||
            ""
        ),
        published:
          item.firstPublicationDate ||
          item.pubYear ||
          null,
        doi: item.doi || null,
      };
    })
    .filter(
      (source) =>
        source.title &&
        (source.content.length >= MIN_CONTENT_LENGTH ||
          source.url)
    );
}

/* ---------------------------------------------------------
 * Wikipedia
 * --------------------------------------------------------- */

async function searchWikipedia(query, rows) {
  const url =
    `https://en.wikipedia.org/w/api.php` +
    `?action=query` +
    `&generator=search` +
    `&gsrsearch=${encodeURIComponent(query)}` +
    `&gsrnamespace=0` +
    `&gsrlimit=${Math.min(
      Number(rows) || DEFAULT_RESULTS_PER_QUERY,
      50
    )}` +
    `&prop=extracts` +
    `&explaintext=1` +
    `&format=json` +
    `&origin=*`;

  const data = await getJson(url);

  return Object.values(data?.query?.pages || {})
    .map((page) => ({
      provider: "wikipedia",
      title: clean(page.title || "Untitled"),
      authors: "Wikipedia contributors",
      url: page.pageid
        ? `https://en.wikipedia.org/?curid=${page.pageid}`
        : null,
      content: clean(page.extract || ""),
      published: null,
    }))
    .filter(
      (source) =>
        source.title &&
        source.content.length >= MIN_CONTENT_LENGTH
    );
}

/* ---------------------------------------------------------
 * Safe provider execution
 * --------------------------------------------------------- */

async function safeSearch(
  name,
  fn,
  query,
  rows
) {
  try {
    return await fn(query, rows);
  } catch (error) {
    console.warn(
      `[webSources] ${name} search failed: ${
        error?.message || error
      }`
    );

    return [];
  }
}

/* ---------------------------------------------------------
 * Deduplication
 * --------------------------------------------------------- */

function sourceKey(source) {
  const url = String(source.url || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");

  if (url) {
    return `url:${url}`;
  }

  const title = clean(source.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return `title:${title}`;
}

/* ---------------------------------------------------------
 * Main source discovery
 * --------------------------------------------------------- */

async function fetchWebSources(
  documentText,
  onProgress = () => {}
) {
  if (!config.web.enabled) {
    return [];
  }

  const queryCount =
    Number(config.web.queries) ||
    DEFAULT_QUERY_COUNT;

  const rows =
    Number(config.web.resultsPerQuery) ||
    DEFAULT_RESULTS_PER_QUERY;

  const queries = buildQueries(
    documentText,
    queryCount
  );

  const collected = [];

  /*
   * Run each provider independently.
   *
   * This means Semantic Scholar returning 429 does not
   * prevent OpenAlex/Crossref/Europe PMC from working.
   */
  const providers = [
    ["OpenAlex", searchOpenAlex],
    ["Crossref", searchCrossref],
    ["Europe PMC", searchEuropePmc],
    ["Semantic Scholar", searchSemanticScholar],
    ["arXiv", searchArxiv],
    ["Wikipedia", searchWikipedia],
  ];

  for (const [index, query] of queries.entries()) {
    onProgress(
      `Searching online sources (${index + 1}/${queries.length})`
    );

    const results = await Promise.all(
      providers.map(([name, fn]) =>
        safeSearch(
          name,
          fn,
          query,
          rows
        )
      )
    );

    for (const batch of results) {
      collected.push(...batch);
    }
  }

  /*
   * Deduplicate.
   */
  const seen = new Set();
  const unique = [];

  for (const source of collected) {
    const key = sourceKey(source);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    unique.push({
      ...source,
      sourceType: "web",
    });
  }

  return unique;
}

module.exports = {
  fetchWebSources,
  buildQueries,
};