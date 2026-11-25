
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD (minimum 12 characters).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : undefined
});

const query = (sql, params = []) => pool.query(sql, params);

async function init() {
  await query(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name_hi TEXT NOT NULL,
      name_en TEXT DEFAULT '',
      price NUMERIC(12,2) NOT NULL CHECK(price >= 0),
      unit TEXT DEFAULT '',
      category TEXT DEFAULT 'अन्य',
      active INTEGER DEFAULT 1
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_no TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      village TEXT NOT NULL,
      address TEXT NOT NULL,
      subtotal NUMERIC(12,2) NOT NULL,
      delivery_fee NUMERIC(12,2) NOT NULL,
      total NUMERIC(12,2) NOT NULL,
      payment_method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'नया',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id BIGINT,
      product_name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      quantity INTEGER NOT NULL
    )
  `);

  const existing = await query(
    'SELECT id FROM admins WHERE username = $1',
    [process.env.ADMIN_USERNAME]
  );

  if (existing.rowCount === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await query(
      'INSERT INTO admins(username, password_hash) VALUES($1, $2)',
      [process.env.ADMIN_USERNAME, hash]
    );
    console.log('Initial admin account created.');
  }
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const requireAdmin = (req, res, next) =>
  req.session && req.session.admin
    ? next()
    : res.status(401).json({ error: 'लॉगिन आवश्यक है।' });

app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (e) {
    res.status(503).json({ ok: false, database: 'disconnected' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/products', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name_hi, name_en, price, unit, category
       FROM products WHERE active = 1
       ORDER BY category, name_hi`
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'सामान लोड नहीं हो सका।' });
  }
});

app.post('/api/orders', orderLimiter, async (req, res) => {
  const client = await pool.connect();

  try {
    const { customer, items, payment_method } = req.body || {};

    if (!customer || !Array.isArray(items) || !items.length || items.length > 100) {
      return res.status(400).json({ error: 'ऑर्डर की जानकारी अधूरी है।' });
    }

    const name = String(customer.name || '').trim();
    const phone = String(customer.phone || '').replace(/\D/g, '');
    const village = String(customer.village || '').trim();
    const address = String(customer.address || '').trim();

    if (!name || phone.length !== 10 || !village || !address) {
      return res.status(400).json({
        error: 'नाम, 10 अंकों का मोबाइल, गांव और पता सही भरें।'
      });
    }

    await client.query('BEGIN');

    let subtotal = 0;
    const checked = [];

    for (const item of items) {
      const id = Number(item.id);
      const qty = Number(item.quantity);

      if (!Number.isSafeInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 99) {
        throw new Error('INVALID_ITEM');
      }

      const result = await client.query(
        'SELECT id, name_hi, price FROM products WHERE id = $1 AND active = 1',
        [id]
      );

      if (!result.rows.length) throw new Error('PRODUCT_UNAVAILABLE');

      const product = result.rows[0];
      const price = Number(product.price);

      subtotal += price * qty;
      checked.push({ ...product, price, quantity: qty });
    }

    subtotal = Number(subtotal.toFixed(2));
    const delivery_fee = subtotal > 500 ? 0 : 10;
    const total = Number((subtotal + delivery_fee).toFixed(2));
    const order_no = 'JAY-' + Date.now().toString().slice(-8);

    const order = await client.query(
      `INSERT INTO orders
       (order_no, customer_name, phone, village, address,
        subtotal, delivery_fee, total, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        order_no, name, phone, village, address,
        subtotal, delivery_fee, total,
        'कैश ऑन डिलीवरी'
      ]
    );

    for (const p of checked) {
      await client.query(
        `INSERT INTO order_items
         (order_id, product_id, product_name, price, quantity)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.rows[0].id, p.id, p.name_hi, p.price, p.quantity]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      ok: true,
      order_no,
      subtotal,
      delivery_fee,
      total,
      items: checked
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});

    if (e.message === 'INVALID_ITEM') {
      return res.status(400).json({ error: 'सामान की मात्रा सही नहीं है।' });
    }
    if (e.message === 'PRODUCT_UNAVAILABLE') {
      return res.status(400).json({
        error: 'चुना हुआ सामान उपलब्ध नहीं है। पेज रीफ्रेश करें।'
      });
    }

    console.error(e);
    res.status(500).json({ error: 'ऑर्डर सेव नहीं हो सका। कृपया दोबारा प्रयास करें।' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');

    const result = await query(
      'SELECT * FROM admins WHERE username = $1',
      [username]
    );

    const admin = result.rows[0];

    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ error: 'यूज़रनेम या पासवर्ड गलत है।' });
    }

    req.session.admin = {
      id: admin.id,
      username: admin.username
    };

    res.json({ ok: true, username: admin.username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'लॉगिन नहीं हो सका।' });
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ username: req.session.admin.username });
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM orders ORDER BY id DESC LIMIT 200'
    );

    for (const order of result.rows) {
      const items = await query(
        `SELECT product_name, price, quantity
         FROM order_items WHERE order_id = $1`,
        [order.id]
      );
      order.items = items.rows;
    }

    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ऑर्डर लोड नहीं हो सके।' });
  }
});

app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const allowed = ['नया', 'स्वीकृत', 'तैयार', 'डिलीवरी के लिए निकला', 'डिलीवर', 'रद्द'];
  const status = String(req.body.status || '');

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'स्थिति मान्य नहीं है।' });
  }

  try {
    const result = await query(
      'UPDATE orders SET status = $1 WHERE id = $2',
      [status, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'ऑर्डर नहीं मिला।' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'स्थिति अपडेट नहीं हुई।' });
  }
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const { name_hi, name_en = '', price, unit = '', category = 'अन्य' } = req.body || {};

  if (!String(name_hi || '').trim() || !Number.isFinite(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'सामान का नाम और सही कीमत भरें।' });
  }

  try {
    const result = await query(
      `INSERT INTO products(name_hi, name_en, price, unit, category)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [
        String(name_hi).trim(),
        String(name_en).trim(),
        Number(price),
        String(unit),
        String(category)
      ]
    );

    res.status(201).json({ id: result.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'सामान सेव नहीं हुआ।' });
  }
});

app.patch('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const { name_hi, name_en = '', price, unit = '', category = 'अन्य', active = 1 } = req.body || {};

  if (!String(name_hi || '').trim() || !Number.isFinite(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'सामान का नाम और सही कीमत भरें।' });
  }

  try {
    const result = await query(
      `UPDATE products
       SET name_hi=$1, name_en=$2, price=$3, unit=$4, category=$5, active=$6
       WHERE id=$7`,
      [
        String(name_hi).trim(),
        String(name_en).trim(),
        Number(price),
        String(unit),
        String(category),
        active ? 1 : 0,
        req.params.id
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'सामान नहीं मिला।' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'सामान अपडेट नहीं हुआ।' });
  }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const result = await query(
      'UPDATE products SET active=0 WHERE id=$1',
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'सामान नहीं मिला।' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'सामान हटाया नहीं जा सका।' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

init()
  .then(() => app.listen(PORT, () => {
    console.log(`Jay Enterprises server listening on ${PORT}`);
  }))
  .catch(e => {
    console.error('Database initialization failed:', e);
    process.exit(1);
  });
