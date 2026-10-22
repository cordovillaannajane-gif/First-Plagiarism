const form = document.getElementById("upload-form");
const fileInput = document.getElementById("file");
const dropzone = document.getElementById("dropzone");
const fileName = document.getElementById("file-name");
const submitBtn = document.getElementById("submit");
const progress = document.getElementById("progress");
const progressText = document.getElementById("progress-text");
const barFill = document.getElementById("bar-fill");
const errorBox = document.getElementById("error");
const results = document.getElementById("results");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- service health ----
fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    document.getElementById("health").textContent =
      `database: ${h.database === "ok" ? "connected" : "error"} · Ollama: ${h.ollama}`;
  })
  .catch(() => {
    document.getElementById("health").textContent = "services unreachable";
  });

// ---- file selection ----
function setFile(file) {
  if (!file) return;
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    showError("Only PDF files can be scanned. Please choose a .pdf file.");
    submitBtn.disabled = true;
    fileName.textContent = "";
    return;
  }
  hideError();
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileName.textContent = `${file.name} (${(file.size / 1048576).toFixed(2)} MB)`;
  submitBtn.disabled = false;
}

fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("over");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("over");
  }),
);
dropzone.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove("hidden");
}
function hideError() {
  errorBox.classList.add("hidden");
}

// ---- submit + streamed progress ----
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!fileInput.files[0]) return;

  hideError();
  results.classList.add("hidden");
  progress.classList.remove("hidden");
  submitBtn.disabled = true;
  let steps = 0;
  barFill.style.width = "5%";
  progressText.textContent = "Uploading the PDF…";

  const body = new FormData();
  body.append("file", fileInput.files[0]);

  try {
    const res = await fetch("/api/scan", { method: "POST", body });
    if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
      const data = await res.json();
      throw new Error(data.error || "Upload rejected.");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === "progress") {
          steps++;
          progressText.textContent = msg.message;
          barFill.style.width = `${Math.min(92, 8 + steps * 6)}%`;
        } else if (msg.type === "error") {
          throw new Error(msg.message);
        } else if (msg.type === "result") {
          barFill.style.width = "100%";
          render(msg.result);
        }
      }
    }
  } catch (err) {
    showError(err.message || "Scan failed.");
  } finally {
    progress.classList.add("hidden");
    submitBtn.disabled = false;
  }
});

// ---- results ----
function levelColor(pct) {
  if (pct >= 75) return "var(--veryhigh)";
  if (pct >= 50) return "var(--high)";
  if (pct >= 20) return "var(--moderate)";
  return "var(--low)";
}

function render(r) {
  const gauge = document.getElementById("gauge");
  gauge.style.setProperty("--pct", `${r.similarityPercent}%`);
  gauge.style.setProperty("--gauge-color", levelColor(r.similarityPercent));
  document.getElementById("score").textContent = `${r.similarityPercent}%`;
  document.getElementById("level").textContent = r.similarityLevel;
  document.getElementById("level").style.color = levelColor(r.similarityPercent);
  document.getElementById("meta").textContent =
    `Scan #${r.scanId} · ${r.totalChunks} sections analysed · ${r.sourcesCompared} candidate sources · ` +
    `${r.embeddingsUsed ? "Ollama embeddings" : "keyword/phrase matching"} · ${(r.durationMs / 1000).toFixed(1)}s`;

  const detail = document.getElementById("detail");
  const cleanNote = document.getElementById("clean-note");

  if (!r.detailed) {
    detail.classList.add("hidden");
    cleanNote.classList.remove("hidden");
  } else {
    cleanNote.classList.add("hidden");
    detail.classList.remove("hidden");

    document.getElementById("sources").innerHTML = r.sources
      .map(
        (s) => `<li>
          <span class="pill">${s.similarityPercent}%</span>
          <div class="tag">${s.sourceType === "local" ? "database study" : `online · ${esc(s.provider)}`}</div>
          <div>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}</div>
          ${s.authors ? `<div class="muted">${esc(s.authors)}</div>` : ""}
          <div class="muted">${s.matchedChunks} matching section(s)</div>
        </li>`,
      )
      .join("");

    document.getElementById("sections").innerHTML = r.matchedSections
      .sort((a, b) => b.similarity - a.similarity)
      .map(
        (sec) => `<div class="section">
          <span class="pill">${sec.similarity}%</span>
          <div class="tag">Section ${sec.chunkIndex + 1} · matches ${
            sec.sourceUrl
              ? `<a href="${esc(sec.sourceUrl)}" target="_blank" rel="noopener">${esc(sec.sourceTitle)}</a>`
              : esc(sec.sourceTitle)
          }</div>
          <div class="pair">
            <blockquote>${esc(sec.uploadedText)}</blockquote>
            ${sec.sourceText ? `<blockquote class="source">${esc(sec.sourceText)}</blockquote>` : ""}
          </div>
          ${sec.phrases?.length ? `<div class="phrases">Shared phrases: ${esc(sec.phrases.join(" | "))}</div>` : ""}
        </div>`,
      )
      .join("");
  }

  results.classList.remove("hidden");
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}
