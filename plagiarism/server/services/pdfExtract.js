const fs = require("fs");
const pdfParse = require("pdf-parse");

/**
 * Validates that a buffer is a complete, readable PDF.
 */
function validatePdfBuffer(buffer) {
  if (!buffer || buffer.length < 1024) {
    return {
      ok: false,
      reason: "File is empty or too small to be a valid PDF.",
    };
  }

  const header = buffer.subarray(0, 1024).toString("latin1");

  if (!header.startsWith("%PDF-")) {
    return {
      ok: false,
      reason: "Only PDF files are accepted (missing %PDF header).",
    };
  }

  const tail = buffer
    .subarray(Math.max(0, buffer.length - 2048))
    .toString("latin1");

  if (!tail.includes("%%EOF")) {
    return {
      ok: false,
      reason:
        "The PDF appears incomplete or corrupted (missing end-of-file marker).",
    };
  }

  return { ok: true };
}

/**
 * Normalizes extracted PDF text.
 */
function normalizeText(raw) {
  return String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/-\n(?=[a-z])/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Removes obvious PDF/journal metadata that should not become
 * plagiarism-search queries.
 */
function removePdfNoise(text) {
  return text
    .replace(
      /\b(Academic Editor|Associate Editor|Editor|Received|Revised|Accepted|Published|Citation|DOI)\s*[:\-]?[^\n]{0,250}/gi,
      " ",
    )
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi, " ")
    .replace(/\bPage\s+\d+\s*(of\s+\d+)?\b/gi, " ")
    .replace(/\b\d+\s*\/\s*\d+\b/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Finds the beginning of a References/Bibliography section.
 */
function findReferenceStart(text) {
  const patterns = [
    /^\s*references\s*$/im,
    /^\s*bibliography\s*$/im,
    /^\s*works cited\s*$/im,
    /^\s*literature cited\s*$/im,
  ];

  let earliest = -1;

  for (const pattern of patterns) {
    const match = pattern.exec(text);

    if (match && (earliest === -1 || match.index < earliest)) {
      earliest = match.index;
    }
  }

  return earliest;
}

/**
 * Removes the bibliography/reference section from plagiarism analysis.
 *
 * The original extracted text is still returned separately.
 */
function prepareForPlagiarismAnalysis(text) {
  const normalized = normalizeText(text);
  const referenceStart = findReferenceStart(normalized);

  const body =
    referenceStart >= 0
      ? normalized.slice(0, referenceStart).trim()
      : normalized;

  return {
    fullText: normalized,
    bodyText: body,
    referencesExcluded: referenceStart >= 0,
  };
}

/**
 * Extracts the entire text of a PDF.
 */
async function extractPdf(filePath) {
  const buffer = await fs.promises.readFile(filePath);

  const validation = validatePdfBuffer(buffer);

  if (!validation.ok) {
    const err = new Error(validation.reason);
    err.statusCode = 400;
    throw err;
  }

  let parsed;

  try {
    parsed = await pdfParse(buffer);
  } catch (e) {
    const err = new Error(
      "The PDF could not be read. It may be corrupted or password protected.",
    );

    err.statusCode = 400;
    throw err;
  }

  const text = normalizeText(parsed.text || "");

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (wordCount < 50) {
    const err = new Error(
      "No readable text was found in this PDF. Scanned/image-only PDFs are not supported.",
    );

    err.statusCode = 400;
    throw err;
  }

  const analysis = prepareForPlagiarismAnalysis(text);

  return {
    text,
    analysisText: analysis.bodyText,
    referencesExcluded: analysis.referencesExcluded,
    pageCount: parsed.numpages || null,
    charCount: text.length,
  };
}

module.exports = {
  extractPdf,
  validatePdfBuffer,
  normalizeText,
  removePdfNoise,
  prepareForPlagiarismAnalysis,
  findReferenceStart,
};