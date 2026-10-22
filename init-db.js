require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env");
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: true } : undefined });
(async () => {
  try {
    const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
    await pool.query(schema);
    console.log("Database schema installed.");
  } catch (err) {
    console.error("Database initialization failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
