# PDF Plagiarism Detection System (Local)

Similarity-based plagiarism detection for PDF studies. Runs entirely on your own machine:
Node.js + Express backend, plain HTML/CSS/JavaScript frontend, MySQL storage, and local
Ollama embeddings.

- **No third-party plagiarism APIs**, no paid services.
- **Similarity only.** Plagiarism is measured strictly by comparing the uploaded study with
  other studies. AI-generated-text detection is never performed and never affects the score.
- Comparison sources: (1) studies stored in MySQL, (2) open scholarly APIs — Crossref,
  arXiv, Semantic Scholar (free metadata/abstract APIs).

## File tree

```
plagiarism-detector/
├── README.md
├── package.json
├── .env.example
├── db/
│   └── schema.sql               # MySQL schema + seed studies
├── scripts/
│   └── init-db.js               # runs schema.sql (npm run init-db)
├── server/
│   ├── index.js                 # Express app + static frontend
│   ├── config.js                # env config, similarity labels
│   ├── db.js                    # MySQL connection pool
│   ├── routes/
│   │   └── scan.js              # upload, streamed progress, scan history APIs
│   └── services/
│       ├── pdfExtract.js        # PDF validation + full text extraction (pdf-parse)
│       ├── chunker.js           # sections/chunks, tokenising
│       ├── ollama.js            # local Ollama embeddings client
│       ├── similarity.js        # cosine, keyword, phrase matching, scoring
│       ├── webSources.js        # Crossref / arXiv / Semantic Scholar fetching
│       └── scanEngine.js        # pre-filtering, comparison, percentage, persistence
├── public/
│   ├── index.html               # upload page + results panel
│   ├── styles.css
│   └── app.js
└── uploads/                     # created at runtime for stored PDFs
```

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`)
- MySQL 8 (or MariaDB 10.5+)
- [Ollama](https://ollama.com/download) installed and running locally

## 1. Install

```bash
cd plagiarism-detector
npm install
cp .env.example .env       # Windows: copy .env.example .env
```

Edit `.env` and set your MySQL user/password.

## 2. Ollama setup

```bash
# start the local Ollama service (usually starts automatically after install)
ollama serve

# pull the embedding model used for semantic similarity
ollama pull nomic-embed-text

# optional: a general model, if you later add text-comparison prompts
ollama pull llama3.1:8b

# verify
curl http://127.0.0.1:11434/api/tags
```

Ollama is used only to produce embedding vectors that are compared with cosine similarity.
If Ollama is unreachable the scan still runs using keyword and verbatim phrase matching, and
the results panel says so.

## 3. Create the database

Either:

```bash
npm run init-db
```

or manually:

```bash
mysql -u root -p < db/schema.sql
```

This creates `plagiarism_db` with the tables `uploaded_files`, `scans`,
`scan_matched_sources`, `scan_matched_sections`, `studies`, `study_chunks`, and inserts four
seed studies as the starting comparison corpus.

## 4. Run

```bash
npm start          # or: npm run dev
```

Open <http://localhost:3000>, choose a PDF, and press **Scan for plagiarism**. A spinner and
progress bar show each stage; results appear on the same page.

## How scoring works

1. The upload is validated as a complete PDF (`%PDF` header, `%%EOF` trailer, readable text).
2. The entire text is extracted and normalised.
3. Text is split into overlapping sections at sentence/paragraph boundaries
   (`CHUNK_WORDS`, `CHUNK_OVERLAP_WORDS`); very large documents are evenly sampled up to
   `MAX_CHUNKS` so scans stay fast.
4. Candidate sources (database studies + online scholarly results) are **pre-filtered** by
   keyword overlap; only the top `TOP_CANDIDATE_SOURCES` are compared in depth.
5. Each uploaded section is compared with each candidate section using
   `0.6 × embedding cosine + 0.3 × 5-gram phrase overlap + 0.1 × keyword overlap`
   (a strong verbatim overlap alone also counts as a match).
6. Sections scoring at or above `MATCH_THRESHOLD` count as matches; the overall percentage is
   the average best match score across all sections.

### Similarity labels

| Percentage | Label |
| --- | --- |
| below 20% | Low/No Significant Similarity |
| 20–49% | Moderate Similarity |
| 50–74% | High Similarity |
| 75–100% | Very High Similarity |

Below 20% the page shows only the overall percentage and status. At 20% or above it also
lists matching sources with clickable links, per-source percentages, and the matching text
sections side by side with the source text and shared phrases, for uploader/admin review.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | server, MySQL and Ollama status |
| `POST` | `/api/scan` | multipart PDF upload; streams newline-delimited progress then the result |
| `GET` | `/api/scans` | last 50 scans |
| `GET` | `/api/scans/:id` | stored report (sources + sections when ≥ 20%) |

## Adding your own studies to the corpus

```sql
INSERT INTO studies (title, authors, year, url, content)
VALUES ('My Study Title', 'Author Name', 2024, 'https://example.org/paper', 'full text here…');
```

Every future scan compares against it automatically.

## Configuration reference (`.env`)

| Variable | Meaning |
| --- | --- |
| `PORT` | web server port (default 3000) |
| `DB_*` | MySQL connection settings |
| `OLLAMA_URL` / `OLLAMA_EMBED_MODEL` | local Ollama endpoint and embedding model |
| `MAX_UPLOAD_MB` | upload size limit |
| `CHUNK_WORDS` / `CHUNK_OVERLAP_WORDS` / `MAX_CHUNKS` | sectioning behaviour |
| `MATCH_THRESHOLD` | score (0–1) at which a section counts as matching |
| `TOP_CANDIDATE_SOURCES` | how many pre-filtered sources are deeply compared |
| `ENABLE_WEB_SOURCES` | set `false` for fully offline scans |
| `CROSSREF_MAILTO` | contact email Crossref asks for in its polite pool |
| `WEB_QUERIES` / `WEB_RESULTS_PER_QUERY` | breadth of the online search |

## Troubleshooting

- **"Only PDF files are accepted"** — the file is not a PDF or lacks the PDF header.
- **"No readable text was found"** — the PDF is a scan/image; OCR it first.
- **`database: error`** in the header — check `.env` credentials and that MySQL is running.
- **`Ollama: unavailable`** — run `ollama serve` and `ollama pull nomic-embed-text`.
- **Slow first scan** — embeddings for online sources are computed on the fly; lower
  `TOP_CANDIDATE_SOURCES` or `WEB_RESULTS_PER_QUERY` to speed it up.
