// Spalding United AI Centre — shared data server
// Stores each dataset (sponsors, jobs) as a single JSON document in Postgres.
// Runs on Railway with a Postgres plugin attached (provides DATABASE_URL).

import express from "express";
import pg from "pg";

const { Pool } = pg;

// ---- Config ----
const PORT = process.env.PORT || 3000;
// Shared password required to SAVE (write). Reads are open to anyone with the URL.
// Set WRITE_PASSWORD in Railway variables; falls back to the app's shared password.
const WRITE_PASSWORD = process.env.WRITE_PASSWORD || "SpaldingUnited26";
// Only these dataset names are allowed, so nobody can spam arbitrary rows.
const ALLOWED = new Set(["sponsors", "jobs", "fixtures", "matchAnswers", "recipients"]);

if (!process.env.DATABASE_URL) {
  console.error("No DATABASE_URL set. Add a Postgres database in Railway and it will be provided automatically.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's Postgres needs SSL but with a self-signed cert; this allows it.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

// ---- One-time table setup ----
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS datasets (
      name       TEXT PRIMARY KEY,
      data       JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Ensure rows exist so GET always returns something.
  await pool.query(`
    INSERT INTO datasets (name, data) VALUES
      ('sponsors', '[]'::jsonb),
      ('jobs', '[]'::jsonb),
      ('fixtures', '[]'::jsonb),
      ('recipients', '[]'::jsonb),
      ('matchAnswers', '{}'::jsonb)
    ON CONFLICT (name) DO NOTHING;
  `);
  console.log("Database ready.");
}

const app = express();
app.use(express.json({ limit: "5mb" }));

// ---- CORS: let the Netlify page (any origin) call this API ----
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Write-Password");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- Health check ----
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Spalding United AI Centre server" });
});

// ---- Read a dataset ----
app.get("/api/:name", async (req, res) => {
  const { name } = req.params;
  if (!ALLOWED.has(name)) return res.status(404).json({ error: "Unknown dataset" });
  try {
    const { rows } = await pool.query("SELECT data, updated_at FROM datasets WHERE name = $1", [name]);
    if (!rows.length) return res.json({ data: [], updated_at: null });
    res.json({ data: rows[0].data, updated_at: rows[0].updated_at });
  } catch (e) {
    console.error("GET error", e);
    res.status(500).json({ error: "Could not read data" });
  }
});

// ---- Save a dataset (whole list at once) ----
app.put("/api/:name", async (req, res) => {
  const { name } = req.params;
  if (!ALLOWED.has(name)) return res.status(404).json({ error: "Unknown dataset" });

  const pass = req.header("X-Write-Password") || "";
  if (pass !== WRITE_PASSWORD) return res.status(401).json({ error: "Wrong write password" });

  const data = req.body && req.body.data;
  if (data === undefined || data === null || typeof data !== "object") {
    return res.status(400).json({ error: "Body must be { data: [...] } or { data: {...} }" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO datasets (name, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       RETURNING updated_at`,
      [name, JSON.stringify(data)]
    );
    res.json({ ok: true, updated_at: rows[0].updated_at });
  } catch (e) {
    console.error("PUT error", e);
    res.status(500).json({ error: "Could not save data" });
  }
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Server listening on ${PORT}`)))
  .catch((e) => {
    console.error("Startup failed:", e);
    process.exit(1);
  });
