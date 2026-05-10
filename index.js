const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create stats table if it doesn't exist
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
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database init error:', err);
  }
}

initDB();

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'RouteAlert server running' });
});

// Proxy scan requests to Anthropic
app.post('/scan', async (req, res) => {
  try {
    const { image, mediaType } = req.body;
    if (!image || !mediaType) {
      return res.status(400).json({ error: 'Missing image or mediaType' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: image }
            },
            {
              type: 'text',
              text: `Look at this image carefully. It contains a delivery route sheet or manifest.\n\nExtract every row with a street address, top to bottom, in order.\n\nFor each row:\n1. "address" — street number + name (e.g. "5 ORCUTTVILLE RD")\n2. "qty" — number in the column DIRECTLY LEFT of the address (package count)\n3. "pickup" — true if the word "pickup" appears anywhere near that row, otherwise false\n\nOutput ONLY a raw JSON array of objects. No markdown, no explanation.\n\nExample: [{"address":"5 Orcuttville Rd","qty":3,"pickup":false}]\n\nIf no addresses: []`
            }
          ]
        }]
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
    if (total_stops === undefined) return res.status(400).json({ error: 'Missing required stats fields' });
    await pool.query(
      `INSERT INTO route_stats (date, total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [date || new Date().toISOString().split('T')[0], total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Save stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get route stats history
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
    console.error('Get stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// In-memory mailbox store (temporary)
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
