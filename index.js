const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS route_stats (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        total_stops INTEGER NOT NULL,
        total_packages INTEGER NOT NULL,
        mailbox_count INTEGER NOT NULL,
        mailbox_packages INTEGER NOT NULL,
        door_count INTEGER NOT NULL,
        door_packages INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS long_driveways (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database init error:', err);
  }
}

initDB();

// Normalize address for consistent matching
function normalizeAddress(addr) {
  return addr.toLowerCase().trim()
    .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave')
    .replace(/\bdrive\b/g, 'dr').replace(/\broad\b/g, 'rd')
    .replace(/\blane\b/g, 'ln').replace(/\bcourt\b/g, 'ct')
    .replace(/\bcircle\b/g, 'cir').replace(/\bplace\b/g, 'pl')
    .replace(/\bboule?vard\b/g, 'blvd').replace(/\bterrace\b/g, 'ter')
    .replace(/\s+/g, ' ');
}

app.get('/', (req, res) => {
  res.json({ status: 'RouteAlert server running' });
});

// Scan
app.post('/scan', async (req, res) => {
  try {
    const { image, mediaType } = req.body;
    if (!image || !mediaType) return res.status(400).json({ error: 'Missing image or mediaType' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: `Look at this image carefully. It contains a delivery route sheet or manifest.\n\nExtract every row with a street address, top to bottom, in order.\n\nFor each row:\n1. "address" — street number + name (e.g. "5 ORCUTTVILLE RD")\n2. "qty" — number in the column DIRECTLY LEFT of the address (package count)\n3. "pickup" — true if the word "pickup" appears anywhere near that row, otherwise false\n\nOutput ONLY a raw JSON array of objects. No markdown, no explanation.\n\nExample: [{"address":"5 Orcuttville Rd","qty":3,"pickup":false}]\n\nIf no addresses: []` }
        ]}]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const raw = data.content?.map(b => b.text || '').join('') || '';
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : '[]');
    const filtered = parsed.filter(item => {
      if (item.pickup === true) return false;
      const text = (typeof item === 'string' ? item : item.address) || '';
      return !/pickup/i.test(text);
    });
    res.json({ addresses: filtered });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save route stats
app.post('/stats', async (req, res) => {
  try {
    const { date, total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages } = req.body;
    if (total_stops === undefined) return res.status(400).json({ error: 'Missing fields' });
    await pool.query(
      `INSERT INTO route_stats (date, total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [date || new Date().toISOString().split('T')[0], total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Save stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get route stats
app.get('/stats', async (req, res) => {
  try {
    const { period } = req.query;
    let query = `SELECT * FROM route_stats ORDER BY date DESC`;
    if (period === 'week') query = `SELECT * FROM route_stats WHERE date >= NOW() - INTERVAL '7 days' ORDER BY date DESC`;
    else if (period === 'month') query = `SELECT * FROM route_stats WHERE date >= NOW() - INTERVAL '30 days' ORDER BY date DESC`;
    else if (period === 'year') query = `SELECT * FROM route_stats WHERE date >= NOW() - INTERVAL '365 days' ORDER BY date DESC`;
    const result = await pool.query(query);
    res.json({ stats: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add long driveway
app.post('/driveway', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'Missing address' });
    const normalized = normalizeAddress(address);
    await pool.query(
      `INSERT INTO long_driveways (address) VALUES ($1) ON CONFLICT (address) DO NOTHING`,
      [normalized]
    );
    res.json({ success: true, normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all long driveways
app.get('/driveway', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM long_driveways ORDER BY address ASC`);
    res.json({ driveways: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if address is a long driveway
app.get('/driveway/check', async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'Missing address' });
    const normalized = normalizeAddress(address);
    const result = await pool.query(`SELECT id FROM long_driveways WHERE address = $1`, [normalized]);
    res.json({ isLongDriveway: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete long driveway
app.delete('/driveway/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM long_driveways WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mailbox locations (in-memory for now)
const mailboxLocations = {};
app.post('/mailbox', async (req, res) => {
  try {
    const { address, lat, lng } = req.body;
    if (!address || !lat || !lng) return res.status(400).json({ error: 'Missing fields' });
    mailboxLocations[address.toLowerCase().trim()] = { lat, lng };
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/mailbox', async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'Missing address' });
    const location = mailboxLocations[address.toLowerCase().trim()];
    if (!location) return res.status(404).json({ error: 'Not found' });
    res.json(location);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RouteAlert server running on port ${PORT}`));
