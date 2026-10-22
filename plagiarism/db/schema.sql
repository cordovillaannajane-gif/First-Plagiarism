-- PDF Plagiarism Detection System - MySQL schema + seed data
-- Usage: mysql -u root -p < db/schema.sql

CREATE DATABASE IF NOT EXISTS plagiarism_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE plagiarism_db;

-- ---------------------------------------------------------------------------
-- Uploaded PDF files
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uploaded_files (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  original_name VARCHAR(512)  NOT NULL,
  stored_name   VARCHAR(512)  NOT NULL,
  mime_type     VARCHAR(128)  NOT NULL,
  file_size     BIGINT        NOT NULL,
  page_count    INT           DEFAULT NULL,
  char_count    INT           DEFAULT NULL,
  extracted_text LONGTEXT     DEFAULT NULL,
  uploaded_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_uploaded_at (uploaded_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Scan results (one row per completed scan)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scans (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  file_id              INT NOT NULL,
  status               ENUM('pending','running','completed','failed') NOT NULL DEFAULT 'pending',
  similarity_percent   DECIMAL(5,2) DEFAULT NULL,
  similarity_level     VARCHAR(64)  DEFAULT NULL,
  total_chunks         INT          DEFAULT NULL,
  matched_chunks       INT          DEFAULT NULL,
  sources_compared     INT          DEFAULT NULL,
  duration_ms          INT          DEFAULT NULL,
  error_message        TEXT         DEFAULT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at         DATETIME DEFAULT NULL,
  CONSTRAINT fk_scan_file FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE,
  INDEX idx_scan_created (created_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Matched sources per scan (local studies and online scholarly documents)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_matched_sources (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  scan_id            INT NOT NULL,
  source_type        ENUM('local','web') NOT NULL,
  source_ref_id      INT DEFAULT NULL,          -- studies.id when source_type='local'
  title              VARCHAR(768) NOT NULL,
  authors            VARCHAR(768) DEFAULT NULL,
  url                VARCHAR(1024) DEFAULT NULL,
  provider           VARCHAR(64)  DEFAULT NULL, -- crossref | arxiv | semanticscholar | database
  similarity_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  matched_chunks     INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_source_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE,
  INDEX idx_source_scan (scan_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Matching text sections, for uploader/admin review
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_matched_sections (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  scan_id            INT NOT NULL,
  matched_source_id  INT DEFAULT NULL,
  chunk_index        INT NOT NULL,
  uploaded_text      TEXT NOT NULL,
  source_text        TEXT DEFAULT NULL,
  similarity_percent DECIMAL(5,2) NOT NULL,
  matched_phrases    TEXT DEFAULT NULL,
  CONSTRAINT fk_section_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE,
  CONSTRAINT fk_section_source FOREIGN KEY (matched_source_id) REFERENCES scan_matched_sources(id) ON DELETE SET NULL,
  INDEX idx_section_scan (scan_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Existing studies stored in the database (comparison corpus)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS studies (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(768) NOT NULL,
  authors     VARCHAR(768) DEFAULT NULL,
  year        INT DEFAULT NULL,
  url         VARCHAR(1024) DEFAULT NULL,
  content     LONGTEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FULLTEXT KEY ft_studies (title, content)
) ENGINE=InnoDB;

-- Cached chunk embeddings for corpus studies (speeds up repeated scans)
CREATE TABLE IF NOT EXISTS study_chunks (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  study_id    INT NOT NULL,
  chunk_index INT NOT NULL,
  content     TEXT NOT NULL,
  embedding   JSON DEFAULT NULL,
  model       VARCHAR(128) DEFAULT NULL,
  CONSTRAINT fk_chunk_study FOREIGN KEY (study_id) REFERENCES studies(id) ON DELETE CASCADE,
  UNIQUE KEY uq_study_chunk (study_id, chunk_index)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Seed corpus
-- ---------------------------------------------------------------------------
INSERT INTO studies (title, authors, year, url, content) VALUES
('Machine Learning Approaches for Student Performance Prediction',
 'A. Reyes; M. Santos', 2021, 'https://example.org/studies/ml-student-performance',
 'This study examines machine learning approaches for predicting student academic performance in higher education. Historical academic records, attendance data and demographic attributes were used as predictors. Decision trees, random forests and support vector machines were trained and evaluated using accuracy, precision, recall and F1-score. The random forest classifier produced the highest accuracy, indicating that ensemble methods handle heterogeneous educational data effectively. Results suggest that early identification of at-risk students allows institutions to provide timely academic interventions and reduce dropout rates. The researchers recommend integrating predictive dashboards into the student information system so advisers can monitor progress each term.'),
('A Survey of Text Similarity Measures for Document Comparison',
 'J. Cruz; L. Tan', 2019, 'https://example.org/studies/text-similarity-survey',
 'Text similarity measurement is a fundamental task in information retrieval and natural language processing. This survey reviews lexical measures such as Jaccard coefficient, cosine similarity over term frequency vectors and n-gram overlap, along with semantic measures based on distributed word representations and sentence embeddings. Lexical methods are computationally inexpensive and effective for verbatim copying, while embedding based methods capture paraphrase and meaning preserving rewrites. A hybrid pipeline that pre-filters candidate documents using keyword overlap and then re-ranks them using embedding cosine similarity offers the best balance between speed and accuracy for large corpora.'),
('Web Based Document Management System for Academic Institutions',
 'R. Dela Cruz', 2020, 'https://example.org/studies/document-management',
 'The proposed web based document management system centralises the storage, retrieval and archiving of academic records. The system was developed using an agile methodology with iterative prototyping and user acceptance testing. Modules include document upload with validation, metadata tagging, role based access control, full text search and audit logging. Evaluation with faculty and staff respondents showed high acceptability in terms of functionality, reliability, usability and efficiency. The study concludes that digitising document workflows shortens processing time and improves accountability compared with manual paper based filing.'),
('Sentiment Analysis of Online Course Feedback Using Natural Language Processing',
 'K. Villanueva; P. Ong', 2022, 'https://example.org/studies/sentiment-course-feedback',
 'This research applies natural language processing to analyse student feedback collected from online courses. Comments were pre-processed through tokenisation, stop word removal and lemmatisation before being converted into feature vectors. Both lexicon based scoring and supervised classification were compared for polarity detection. The supervised model achieved better agreement with human annotators, particularly for mixed sentiment statements. Thematic clustering of negative comments revealed recurring concerns about pacing, assessment clarity and instructor responsiveness, giving course designers actionable guidance for revision.');
