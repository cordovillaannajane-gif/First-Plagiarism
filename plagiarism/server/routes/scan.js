const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const config = require("../config");
const db = require("../db");
const { extractPdf } = require("../services/pdfExtract");
const { runScan } = require("../services/scanEngine");
const ollama = require("../services/ollama");

const router = express.Router();
const uploadDir = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.-]/g, "_")}`),
  }),
  limits: { fileSize: config.scan.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const isPdf =
      file.mimetype === "application/pdf" && /\.pdf$/i.test(file.originalname);
    if (!isPdf) return cb(new Error("Only PDF files are accepted."));
    cb(null, true);
  },
});

router.get("/health", async (_req, res) => {
  const out = { server: "ok", database: "unknown", ollama: "unknown" };
  try {
    await db.ping();
    out.database = "ok";
  } catch (e) {
    out.database = `error: ${e.message}`;
  }
  out.ollama = (await ollama.isAvailable()) ? "ok" : "unavailable";
  res.json(out);
});

/**
 * POST /api/scan  (multipart: file)
 * Streams progress as newline-delimited JSON, ending with the final result.
 */
router.post("/scan", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF file was uploaded." });

  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);
  const progress = (message) => send({ type: "progress", message });

  let scanId = null;
  try {
    progress("Validating and reading the PDF");
    const { text, pageCount, charCount } = await extractPdf(req.file.path);

    const fileId = await db.insert(
      `INSERT INTO uploaded_files
        (original_name, stored_name, mime_type, file_size, page_count, char_count, extracted_text)
       VALUES (?,?,?,?,?,?,?)`,
      [
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        pageCount,
        charCount,
        text,
      ],
    );
    scanId = await db.insert("INSERT INTO scans (file_id, status) VALUES (?, 'running')", [fileId]);
    send({ type: "started", scanId, fileId, pageCount });

    const result = await runScan({ scanId, fileId, text }, progress);
    send({ type: "result", result });
    res.end();
  } catch (err) {
    console.error(err);
    if (scanId) {
      await db
        .query("UPDATE scans SET status='failed', error_message=? WHERE id=?", [
          String(err.message).slice(0, 1000),
          scanId,
        ])
        .catch(() => {});
    }
    send({ type: "error", message: err.message || "Scan failed." });
    res.end();
  }
});

/** Scan history (admin review). */
router.get("/scans", async (_req, res) => {
  const rows = await db.query(
    `SELECT s.id, s.similarity_percent, s.similarity_level, s.status, s.created_at,
            f.original_name, f.page_count
     FROM scans s JOIN uploaded_files f ON f.id = s.file_id
     ORDER BY s.id DESC LIMIT 50`,
  );
  res.json(rows);
});

/** Full stored report for one scan. */
router.get("/scans/:id", async (req, res) => {
  const [scan] = await db.query(
    `SELECT s.*, f.original_name, f.page_count FROM scans s
     JOIN uploaded_files f ON f.id = s.file_id WHERE s.id = ?`,
    [req.params.id],
  );
  if (!scan) return res.status(404).json({ error: "Scan not found." });

  const detailed = Number(scan.similarity_percent) >= config.reportThreshold;
  const sources = detailed
    ? await db.query("SELECT * FROM scan_matched_sources WHERE scan_id=? ORDER BY similarity_percent DESC", [scan.id])
    : [];
  const sections = detailed
    ? await db.query("SELECT * FROM scan_matched_sections WHERE scan_id=? ORDER BY chunk_index", [scan.id])
    : [];
  res.json({ scan, detailed, sources, sections });
});

module.exports = router;
