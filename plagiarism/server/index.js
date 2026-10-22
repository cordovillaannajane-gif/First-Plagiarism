const path = require("path");
const express = require("express");
const cors = require("cors");
const config = require("./config");
const scanRoutes = require("./routes/scan");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/api", scanRoutes);

// Multer / generic error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.statusCode || (err.code === "LIMIT_FILE_SIZE" ? 413 : 400);
  res.status(status).json({ error: err.message || "Request failed." });
});

app.listen(config.port, () => {
  console.log(`PDF Plagiarism Detector running at http://localhost:${config.port}`);
  console.log(`Ollama: ${config.ollama.url} (model: ${config.ollama.embedModel})`);
  console.log(`MySQL:  ${config.db.host}:${config.db.port}/${config.db.database}`);
});
