/**
 * Creates the database and tables from db/schema.sql.
 * Usage: npm run init-db
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const config = require("../server/config");

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });
  await conn.query(sql);
  await conn.end();
  console.log("Database and tables created, seed studies inserted.");
})().catch((e) => {
  console.error("Database init failed:", e.message);
  process.exit(1);
});
