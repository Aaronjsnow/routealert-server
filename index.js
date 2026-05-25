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
      CREATE TABLE IF NOT EXISTS mailbox_pins (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        zip TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      ALTER TABLE mailbox_pins ADD COLUMN IF NOT EXISTS zip TEXT
    `);
    await pool.query(`
      ALTER TABLE route_stats ADD COLUMN IF NOT EXISTS route_type TEXT DEFAULT 'usps'
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        last_seen TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scan_usage (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        scan_date DATE NOT NULL DEFAULT CURRENT_DATE,
        scan_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, scan_date)
      )
    `);
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database init error:', err);
  }
}

const DAILY_SCAN_LIMIT = 25;
const UNLIMITED_USERS = ['001641.557eb261676548e58187f7c315450b8f.2313'];

// Check and increment scan count for a user
async function checkScanLimit(userId) {
  if (!userId) return { allowed: false, error: 'User ID required' };
  if (UNLIMITED_USERS.includes(userId)) return { allowed: true, remaining: 999 };

  // Upsert user
  await pool.query(
    `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET last_seen = NOW()`,
    [userId]
  );

  // Get or create today's scan count
  const result = await pool.query(
    `INSERT INTO scan_usage (user_id, scan_date, scan_count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (user_id, scan_date)
     DO UPDATE SET scan_count = scan_usage.scan_count + 1
     RETURNING scan_count`,
    [userId]
  );

  const count = result.rows[0].scan_count;
  if (count > DAILY_SCAN_LIMIT) {
    // Decrement since we over-incremented
    await pool.query(
      `UPDATE scan_usage SET scan_count = scan_count - 1 WHERE user_id = $1 AND scan_date = CURRENT_DATE`,
      [userId]
    );
    return { allowed: false, error: `Daily scan limit of ${DAILY_SCAN_LIMIT} reached. Try again tomorrow.`, remaining: 0 };
  }

  return { allowed: true, remaining: DAILY_SCAN_LIMIT - count };
}

initDB();

// Normalize address for consistent matching
function normalizeAddress(addr) {
  // Strip city/state/zip if present (everything after first comma)
  let result = addr.toLowerCase().trim();
  const commaIdx = result.indexOf(',');
  if (commaIdx !== -1) result = result.substring(0, commaIdx).trim();
  return result
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
    const { image, mediaType, userId } = req.body;
    if (!image || !mediaType) return res.status(400).json({ error: 'Missing image or mediaType' });

    // Check scan limit
    const limit = await checkScanLimit(userId);
    if (!limit.allowed) return res.status(429).json({ error: limit.error, remaining: 0 });
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

// Scan manifest (printed delivery list)
app.post('/scanmanifest', async (req, res) => {
  try {
    const { image, mediaType, userId } = req.body;
    if (!image || !mediaType) return res.status(400).json({ error: 'Missing image or mediaType' });

    // Check scan limit
    const limit = await checkScanLimit(userId);
    if (!limit.allowed) return res.status(429).json({ error: limit.error, remaining: 0 });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: `You are parsing a USPS delivery manifest. Extract every address line as structured JSON. Do NOT deduplicate — if an address appears 3 times, return it 3 times.

RULES:
1. IGNORE ALL NUMBERS on each row. There may be stop numbers or sequence numbers — ignore every number you see. They are never package counts.
2. Extract ONLY the street address text. Ignore any notes or instructions after the address.
3. Include apartment, unit, or suite numbers as part of streetAddress.
4. City, state, and ZIP flow downward. The first line always includes city/state/zip. Each city/state/zip applies to that row and all rows below it until the next city/state/zip appears. Never look upward.
5. Normalize addresses to title case (e.g. "103 Boyer Rd").

Return ONLY a JSON array with one entry per row, no deduplication, no explanation, no markdown:
[{"streetAddress":"103 Boyer Rd","city":"Tolland","state":"CT","zip":"06084"},{"streetAddress":"103 Boyer Rd","city":"Tolland","state":"CT","zip":"06084"},{"streetAddress":"12 Elm Ave","city":"Tolland","state":"CT","zip":"06084"}]` }
        ]}]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const raw = data.content?.map(b => b.text || '').join('') || '';
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : '[]');

    // IGNORE Claude's packageCount entirely — count duplicates ourselves
    // First pass: collect all addresses in order (before dedup)
    const addressList = parsed.map(item => ({
      streetAddress: (item.streetAddress || '').trim(),
      city: item.city || null,
      state: item.state || null,
      zip: item.zip || null
    }));

    // Second pass: count true duplicates by counting occurrences
    const countMap = {};
    const cityMap = {};
    addressList.forEach(item => {
      const key = item.streetAddress.toLowerCase();
      countMap[key] = (countMap[key] || 0) + 1;
      if (item.city) cityMap[key] = { city: item.city, state: item.state, zip: item.zip };
    });

    // Third pass: deduplicate and build final list in order
    const seen = new Set();
    const addresses = [];
    addressList.forEach(item => {
      const key = item.streetAddress.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const location = cityMap[key] || { city: item.city, state: item.state, zip: item.zip };
        addresses.push({
          address: item.streetAddress,
          qty: countMap[key],
          pickup: false,
          city: location.city,
          state: location.state,
          zip: location.zip
        });
      }
    });

    res.json({ addresses });
  } catch (err) {
    console.error('Manifest scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save route stats
app.post('/stats', async (req, res) => {
  try {
    const { date, total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages, hands_free, route_type } = req.body;
    if (total_stops === undefined) return res.status(400).json({ error: 'Missing fields' });
    await pool.query(
      `INSERT INTO route_stats (date, total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages, hands_free, route_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [date || new Date().toISOString().split('T')[0], total_stops, total_packages, mailbox_count, mailbox_packages, door_count, door_packages, hands_free || false, route_type || 'usps']
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
// Save mailbox pin
app.post('/mailboxpin', async (req, res) => {
  try {
    const { address, lat, lng, zip } = req.body;
    if (!address || lat == null || lng == null) return res.status(400).json({ error: 'Missing fields' });
    const normalized = normalizeAddress(address);
    await pool.query(
      `INSERT INTO mailbox_pins (address, lat, lng, zip)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (address) DO UPDATE SET lat = $2, lng = $3, zip = $4`,
      [normalized, lat, lng, zip || null]
    );
    res.json({ success: true, normalized, lat, lng });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get mailbox pins — filter by zip if provided
app.get('/mailboxpin', async (req, res) => {
  try {
    const { zip } = req.query;
    let result;
    if (zip) {
      result = await pool.query(
        `SELECT * FROM mailbox_pins WHERE zip = $1 ORDER BY address ASC`,
        [zip]
      );
    } else {
      result = await pool.query(`SELECT * FROM mailbox_pins ORDER BY address ASC`);
    }
    res.json({ pins: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete mailbox pin
app.delete('/mailboxpin/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM mailbox_pins WHERE id = $1`, [req.params.id]);
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

// Get remaining scans for today
app.get('/scanlimit', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const result = await pool.query(
      `SELECT scan_count FROM scan_usage WHERE user_id = $1 AND scan_date = CURRENT_DATE`,
      [userId]
    );
    const used = result.rows[0]?.scan_count || 0;
    res.json({ used, remaining: Math.max(0, DAILY_SCAN_LIMIT - used), limit: DAILY_SCAN_LIMIT });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Privacy Policy
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RouteAlert Privacy Policy</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1d1d1f; line-height: 1.7; }
  .container { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
  .header { text-align: center; margin-bottom: 48px; }
  .logo { font-size: 48px; margin-bottom: 12px; }
  h1 { font-size: 32px; font-weight: 700; color: #1d1d1f; margin-bottom: 8px; }
  .subtitle { color: #6e6e73; font-size: 15px; }
  .card { background: white; border-radius: 18px; padding: 32px; margin-bottom: 20px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
  h2 { font-size: 20px; font-weight: 600; color: #1d1d1f; margin-bottom: 16px; display: flex; align-items: center; gap: 10px; }
  h2 .icon { font-size: 22px; }
  p { color: #3a3a3c; margin-bottom: 12px; font-size: 15px; }
  p:last-child { margin-bottom: 0; }
  ul { color: #3a3a3c; padding-left: 20px; margin-bottom: 12px; font-size: 15px; }
  li { margin-bottom: 8px; }
  .highlight { background: #f2f7ff; border-left: 4px solid #3b82f6; border-radius: 0 8px 8px 0; padding: 16px 20px; margin: 16px 0; }
  .highlight p { color: #1d4ed8; margin: 0; font-weight: 500; }
  .effective { text-align: center; color: #6e6e73; font-size: 13px; margin-top: 40px; padding-top: 24px; border-top: 1px solid #e5e5ea; }
  a { color: #3b82f6; text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">📦</div>
    <h1>RouteAlert Privacy Policy</h1>
    <p class="subtitle">Last updated: May 19, 2026</p>
  </div>
  <div class="card">
    <h2><span class="icon">👋</span> Overview</h2>
    <p>RouteAlert is a delivery route management tool designed for USPS carriers. We are committed to protecting your privacy and being transparent about how we handle your data.</p>
    <div class="highlight"><p>RouteAlert does not sell your personal information to third parties. Ever.</p></div>
  </div>
  <div class="card">
    <h2><span class="icon">📍</span> Location Data</h2>
    <p>RouteAlert uses your device's GPS to provide proximity alerts as you approach delivery stops.</p>
    <ul>
      <li>Your location is processed entirely on your device — it is never transmitted to our servers.</li>
      <li>We request "Always Allow" location permission so the app can track your route when your screen is off.</li>
      <li>You can revoke location access at any time in iOS Settings.</li>
    </ul>
  </div>
  <div class="card">
    <h2><span class="icon">📷</span> Camera &amp; Photos</h2>
    <p>Photos you take or select are sent to our secure server for AI processing to extract delivery addresses. Images are transmitted securely and are not stored after processing.</p>
  </div>
  <div class="card">
    <h2><span class="icon">🗄️</span> Data We Store</h2>
    <ul>
      <li><strong>Route statistics</strong> — stops, packages, delivery type, and date. Not linked to your identity.</li>
      <li><strong>Long driveway addresses</strong> — addresses marked as long driveways.</li>
      <li><strong>Geocoded coordinates</strong> — cached address coordinates to improve performance.</li>
    </ul>
    <p>None of this data is linked to your name, Apple ID, or any personal identifier.</p>
  </div>
  <div class="card">
    <h2><span class="icon">🤝</span> Third-Party Services</h2>
    <ul>
      <li><strong>Anthropic Claude</strong> — AI model for address extraction. Images not retained. <a href="https://www.anthropic.com/privacy">Privacy Policy</a>.</li>
      <li><strong>Geocodio</strong> — Address geocoding. Only street addresses sent. <a href="https://www.geocod.io/privacy-policy/">Privacy Policy</a>.</li>
      <li><strong>Railway</strong> — Server infrastructure, US-based. <a href="https://railway.app/legal/privacy">Privacy Policy</a>.</li>
    </ul>
  </div>
  <div class="card">
    <h2><span class="icon">👶</span> Children's Privacy</h2>
    <p>RouteAlert is intended for adults in a professional delivery capacity. We do not knowingly collect information from children under 13.</p>
  </div>
  <div class="card">
    <h2><span class="icon">📬</span> Contact</h2>
    <p>Questions? Contact <strong>Aaron Snow</strong>, Developer of RouteAlert.<br>
    Email: <a href="mailto:snowaaronj@gmail.com">snowaaronj@gmail.com</a></p>
  </div>
  <p class="effective">Effective May 19, 2026</p>
</div>
</body>
</html>`);
});


const geocodeCache = new Map();
const GEOCODIO_API_KEY = '2162617987bb9872ba00012a22928909629a223';

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
      geocodeCache.set(cacheKey, result);
      return res.json(result);
    }

    // 3. Call Geocodio API
    const query = zip ? `${address}, ${zip}` : address;
    const encoded = encodeURIComponent(query);
    const url = `https://api.geocod.io/v1.12/geocode?q=${encoded}&api_key=${GEOCODIO_API_KEY}&limit=1`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      console.log(`Geocodio: no results for "${query}"`);
      return res.status(404).json({ error: 'Address not found' });
    }

    const loc = data.results[0].location;
    const result = { lat: loc.lat, lng: loc.lng };

    // Save to both caches
    geocodeCache.set(cacheKey, result);
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
