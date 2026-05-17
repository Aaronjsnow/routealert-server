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
        hands_free BOOLEAN DEFAULT FALSE,
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
      CREATE TABLE IF NOT EXISTS geocode_cache (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS long_driveways (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        radius_feet INTEGER NOT NULL DEFAULT 850,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Add radius_feet column if it doesn't exist (for existing tables)
    await pool.query(`
      ALTER TABLE long_driveways ADD COLUMN IF NOT EXISTS radius_feet INTEGER NOT NULL DEFAULT 850
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
          { type: 'text', text: `Look at this image carefully. It contains a USPS delivery route manifest on a scanner screen.

The columns from left to right are: [icon] [sequence number] [package count] [address]

Extract every row with a street address, top to bottom, in order.

For each row:
1. "address" — street number + name only (e.g. "73 CHAFFEE RD"). Do not include any numbers that are part of the columns.
2. "qty" — the number in the column DIRECTLY AND IMMEDIATELY to the left of the address text. This is the LAST number before the address starts. Do NOT use the first or second number from the left — only the number immediately adjacent to the address.
3. "pickup" — true if the word "pickup" appears anywhere near that row, otherwise false

Output ONLY a raw JSON array of objects. No markdown, no explanation.

Example for a row showing: [icon] 6 1 73 CHAFFEE RD
Correct output: {"address":"73 CHAFFEE RD","qty":1,"pickup":false}
The qty is 1, NOT 6.

If no addresses found: []` }
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
    const { date, total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages, hands_free } = req.body;
    if (total_stops === undefined) return res.status(400).json({ error: 'Missing fields' });
    await pool.query(
      `INSERT INTO route_stats (date, total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages, hands_free) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [date || new Date().toISOString().split('T')[0], total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages, hands_free || false]
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

    // Check if already exists
    const existing = await pool.query(`SELECT id, radius_feet FROM long_driveways WHERE address = $1`, [normalized]);

    if (existing.rows.length > 0) {
      const current = existing.rows[0].radius_feet;
      if (current >= 1250) {
        return res.json({ success: true, normalized, radius_feet: current, maxReached: true });
      }
      // Extend by 400 ft
      const newRadius = current + 400;
      await pool.query(`UPDATE long_driveways SET radius_feet = $1 WHERE address = $2`, [newRadius, normalized]);
      return res.json({ success: true, normalized, radius_feet: newRadius, extended: true });
    }

    // New entry at 850 ft
    await pool.query(
      `INSERT INTO long_driveways (address, radius_feet) VALUES ($1, 850)`,
      [normalized]
    );
    res.json({ success: true, normalized, radius_feet: 850 });
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
    const result = await pool.query(`SELECT id, radius_feet FROM long_driveways WHERE address = $1`, [normalized]);
    if (result.rows.length > 0) {
      res.json({ isLongDriveway: true, radius_feet: result.rows[0].radius_feet });
    } else {
      res.json({ isLongDriveway: false, radius_feet: null });
    }
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

// Delete a route from history
app.delete('/stats/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM route_stats WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Geocode cache to avoid re-requesting the same addresses
const geocodeCache = new Map();

app.get('/geocode', async (req, res) => {
  try {
    const { address, zip } = req.query;
    if (!address) return res.status(400).json({ error: 'Missing address' });

    // Normalize the cache key
    const cacheKey = `${address.toLowerCase().trim()}|${zip || ''}`;

    // 1. Check in-memory cache first (fastest)
    if (geocodeCache.has(cacheKey)) {
      return res.json(geocodeCache.get(cacheKey));
    }

    // 2. Check PostgreSQL cache (persistent across restarts)
    const cached = await pool.query(
      `SELECT lat, lng FROM geocode_cache WHERE address = $1`,
      [cacheKey]
    );
    if (cached.rows.length > 0) {
      const result = { lat: cached.rows[0].lat, lng: cached.rows[0].lng };
      geocodeCache.set(cacheKey, result); // warm in-memory cache too
      return res.json(result);
    }

    // Expand abbreviations for better matching
    function expandAddress(addr) {
      return addr
        .replace(/\bRd\b/gi, 'Road').replace(/\bSt\b/gi, 'Street')
        .replace(/\bAve\b/gi, 'Avenue').replace(/\bDr\b/gi, 'Drive')
        .replace(/\bLn\b/gi, 'Lane').replace(/\bCt\b/gi, 'Court')
        .replace(/\bBlvd\b/gi, 'Boulevard').replace(/\bPl\b/gi, 'Place')
        .replace(/\bCir\b/gi, 'Circle').replace(/\bTer\b/gi, 'Terrace')
        .replace(/\bHwy\b/gi, 'Highway').replace(/\bPkwy\b/gi, 'Parkway')
        .replace(/\bRun\b/gi, 'Run');
    }

    // Build list of queries to try in order
    const queries = [];
    if (zip) {
      queries.push(`${address}, ${zip}`);           // original + zip
      queries.push(`${expandAddress(address)}, ${zip}`); // expanded + zip
      queries.push(`${address}, MA ${zip}`);        // with state
    }
    queries.push(expandAddress(address));            // expanded no zip
    queries.push(address);                           // original no zip

    async function tryQuery(query) {
      const encoded = encodeURIComponent(query);
      const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=5&addressdetails=1`;
      const response = await fetch(url, {
        headers: { 
          'User-Agent': 'RouteAlert/1.0 (routealert delivery app)',
          'Accept': 'application/json'
        }
      });
      
      // Check content type before parsing
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        console.log(`Nominatim returned non-JSON for query: ${query}, status: ${response.status}`);
        return null;
      }
      
      const text = await response.text();
      let results;
      try {
        results = JSON.parse(text);
      } catch (e) {
        console.log(`Failed to parse Nominatim response: ${text.substring(0, 100)}`);
        return null;
      }
      
      if (!results || !results.length) return null;

      // Prefer results matching the zip
      if (zip) {
        const zipMatch = results.find(item => {
          const postcode = item.address?.postcode?.replace(/\s/g, '') || '';
          return postcode.startsWith(zip);
        });
        if (zipMatch) return zipMatch;
      }
      return results[0];
    }

    let best = null;
    for (const query of queries) {
      best = await tryQuery(query);
      if (best) break;
      // Wait 1 second between attempts to respect Nominatim rate limit
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!best) return res.status(404).json({ error: 'Address not found' });
    const result = { lat: parseFloat(best.lat), lng: parseFloat(best.lon) };

    // Save to in-memory cache
    geocodeCache.set(cacheKey, result);

    // Save to PostgreSQL cache (fire and forget)
    pool.query(
      `INSERT INTO geocode_cache (address, lat, lng) VALUES ($1, $2, $3) ON CONFLICT (address) DO NOTHING`,
      [cacheKey, result.lat, result.lng]
    ).catch(err => console.error('Cache save error:', err));

    res.json(result);
  } catch (err) {
    console.error('Geocode error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RouteAlert server running on port ${PORT}`));
