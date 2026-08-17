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
const ALLOWED = new Set(["sponsors", "jobs", "fixtures", "matchAnswers", "recipients", "squad", "salary", "ticketRequests"]);

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
      ('squad', '[]'::jsonb),
      ('matchAnswers', '{}'::jsonb),
      ('salary', '{}'::jsonb),
      ('ticketRequests', '[]'::jsonb)
    ON CONFLICT (name) DO NOTHING;
  `);
  console.log("Database ready.");
}

const app = express();
app.use(express.json({ limit: "5mb" }));

// ---- CORS: let the Netlify page (any origin) call this API ----
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
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

// ---- Public: append ONE ticket request (no password). ----
// This is the only unauthenticated write. It can only add a single, sanitised
// request to the ticketRequests list — it cannot overwrite the list, read it,
// or touch any other dataset.
function clip(v, n){ return (typeof v === "string" ? v : "").slice(0, n); }
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
app.post("/api/ticket-requests/add", async (req, res) => {
  const b = req.body || {};
  const requester = clip(b.requester, 120).trim();
  const fixture   = clip(b.fixture, 200).trim();
  const notes     = clip(b.notes, 1000).trim();
  const oneEmail  = !!b.oneEmail;
  const sharedEmail = clip(b.sharedEmail, 200).trim();

  if (!requester) return res.status(400).json({ error: "Please provide the requester's name." });

  // Sanitise the people array.
  let people = Array.isArray(b.people) ? b.people.slice(0, 100) : [];
  const clean = [];
  for (const p of people) {
    const first = clip(p && p.first, 80).trim();
    const last  = clip(p && p.last, 80).trim();
    if (!first && !last) continue;
    if (!first || !last) return res.status(400).json({ error: "Each person needs a first and last name." });
    let qty = parseInt(p && p.qty, 10); if (!(qty > 0) || qty > 200) qty = 1;
    let email = oneEmail ? sharedEmail : clip(p && p.email, 200).trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "A valid email is required for " + first + " " + last + "." });
    clean.push({ first, last, email, qty });
  }
  if (!clean.length) return res.status(400).json({ error: "Please add at least one person." });
  if (oneEmail && !EMAIL_RE.test(sharedEmail)) return res.status(400).json({ error: "Please provide a valid shared email address." });

  const totalQty = clean.reduce((s, p) => s + p.qty, 0);

  const entry = {
    id: "tr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    requester, fixture, notes,
    oneEmail, sharedEmail: oneEmail ? sharedEmail : "",
    people: clean,
    qty: totalQty,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  try {
    const { rows } = await pool.query("SELECT data FROM datasets WHERE name = 'ticketRequests'");
    let list = rows.length && Array.isArray(rows[0].data) ? rows[0].data : [];
    if (list.length > 5000) return res.status(429).json({ error: "Too many requests stored." });
    list.push(entry);
    await pool.query(
      `INSERT INTO datasets (name, data, updated_at) VALUES ('ticketRequests', $1::jsonb, now())
       ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(list)]
    );
    res.json({ ok: true, id: entry.id });
  } catch (e) {
    console.error("ticket add error", e);
    res.status(500).json({ error: "Could not save your request. Please try again." });
  }
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Server listening on ${PORT}`)))
  .catch((e) => {
    console.error("Startup failed:", e);
    process.exit(1);
  });
