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
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters');
}
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  throw new Error('Admin credentials are required');
}
if (process.env.ADMIN_PASSWORD.length < 12) {
  throw new Error('ADMIN_PASSWORD must be at least 12 characters');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({
    pool,
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      name_en TEXT DEFAULT '',
      price NUMERIC(10,2) NOT NULL,
      category TEXT DEFAULT '',
      image TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      village TEXT DEFAULT '',
      total NUMERIC(10,2) NOT NULL,
      delivery_fee NUMERIC(10,2) NOT NULL,
      status TEXT DEFAULT 'नया',
      payment_method TEXT DEFAULT 'Cash on Delivery',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      quantity INTEGER NOT NULL
    );
  `);

  const admin = await pool.query(
    'SELECT id FROM admins WHERE username = $1',
    [process.env.ADMIN_USERNAME]
  );

  if (admin.rowCount === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await pool.query(
      'INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
      [process.env.ADMIN_USERNAME, hash]
    );
  }
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'कृपया पहले लॉगिन करें' });
  }
  next();
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, name_en, price, category, image, active FROM products WHERE active = 1 ORDER BY id DESC'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'सामान लोड नहीं हो सका' });
  }
});

app.post('/api/orders', async (req, res) => {
  const { customer_name, phone, address, village, items } = req.body;

  if (!customer_name || !phone || !address || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'कृपया सभी जरूरी जानकारी भरें' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let total = 0;
    const verifiedItems = [];

    for (const item of items) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity);

      if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        throw new Error('गलत सामान या मात्रा');
      }

      const product = await client.query(
        'SELECT id, name, price FROM products WHERE id = $1 AND active = 1',
        [productId]
      );

      if (product.rowCount === 0) throw new Error('सामान उपलब्ध नहीं है');

      const p = product.rows[0];
      total += Number(p.price) * quantity;
      verifiedItems.push({ ...p, quantity });
    }

    const deliveryFee = total > 500 ? 0 : 10;

    const order = await client.query(
      `INSERT INTO orders
       (customer_name, phone, address, village, total, delivery_fee)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [customer_name, phone, address, village || '', total, deliveryFee]
    );

    for (const item of verifiedItems) {
      await client.query(
        `INSERT INTO order_items
         (order_id, product_id, product_name, price, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.rows[0].id, item.id, item.name, item.price, item.quantity]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: 'आपका ऑर्डर दर्ज हो गया',
      order_id: order.rows[0].id,
      total,
      delivery_fee: deliveryFee,
      grand_total: total + deliveryFee
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message || 'ऑर्डर दर्ज नहीं हो सका' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query(
      'SELECT id, password_hash FROM admins WHERE username = $1',
      [username]
    );

    if (!result.rowCount || !(await bcrypt.compare(password || '', result.rows[0].password_hash))) {
      return res.status(401).json({ error: 'यूजरनेम या पासवर्ड गलत है' });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'लॉगिन नहीं हो सका' });
      req.session.adminId = result.rows[0].id;
      res.json({ message: 'लॉगिन सफल' });
    });
  } catch (error) {
    res.status(500).json({ error: 'लॉगिन में समस्या हुई' });
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'लॉगआउट सफल' });
  });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ loggedIn: true });
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'ऑर्डर लोड नहीं हुए' });
  }
});

app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const allowed = ['नया', 'स्वीकार', 'तैयार', 'रास्ते में', 'डिलीवर', 'रद्द'];
  const { status } = req.body;

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'गलत स्थिति' });
  }

  try {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ message: 'स्थिति अपडेट हो गई' });
  } catch (error) {
    res.status(500).json({ error: 'अपडेट नहीं हुआ' });
  }
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const { name, name_en, price, category, image } = req.body;

  if (!name || !Number.isFinite(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'सामान का नाम और सही कीमत भरें' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (name, name_en, price, category, image)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, name_en || '', price, category || '', image || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'सामान जोड़ा नहीं जा सका' });
  }
});

app.patch('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const { name, name_en, price, category, image, active } = req.body;

  try {
    const result = await pool.query(
      `UPDATE products
       SET name = COALESCE($1, name),
           name_en = COALESCE($2, name_en),
           price = COALESCE($3, price),
           category = COALESCE($4, category),
           image = COALESCE($5, image),
           active = COALESCE($6, active)
       WHERE id = $7 RETURNING *`,
      [name ?? null, name_en ?? null, price ?? null, category ?? null, image ?? null, active ?? null, req.params.id]
    );

    if (!result.rowCount) return res.status(404).json({ error: 'सामान नहीं मिला' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'सामान अपडेट नहीं हुआ' });
  }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE products SET active = 0 WHERE id = $1', [req.params.id]);
    res.json({ message: 'सामान हटाया गया' });
  } catch (error) {
    res.status(500).json({ error: 'सामान हटाया नहीं जा सका' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Jay Enterprises running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  }
}

start();
