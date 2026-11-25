const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'jay-enterprises.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be set to a random value at least 32 characters long.');
  process.exit(1);
}
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD (at least 12 characters) in environment variables.');
  process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);
const run = (sql, params=[]) => new Promise((resolve,reject)=>db.run(sql,params,function(err){err?reject(err):resolve(this)}));
const get = (sql, params=[]) => new Promise((resolve,reject)=>db.get(sql,params,(err,row)=>err?reject(err):resolve(row)));
const all = (sql, params=[]) => new Promise((resolve,reject)=>db.all(sql,params,(err,rows)=>err?reject(err):resolve(rows)));

async function init(){
  await run(`CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)`);
  await run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name_hi TEXT NOT NULL, name_en TEXT DEFAULT '', price REAL NOT NULL CHECK(price>=0), unit TEXT DEFAULT '', category TEXT DEFAULT 'अन्य', active INTEGER DEFAULT 1)`);
  await run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL, village TEXT NOT NULL, address TEXT NOT NULL, subtotal REAL NOT NULL, delivery_fee REAL NOT NULL, total REAL NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'नया', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER, product_name TEXT NOT NULL, price REAL NOT NULL, quantity INTEGER NOT NULL, FOREIGN KEY(order_id) REFERENCES orders(id))`);
  const existing = await get('SELECT id FROM admins WHERE username=?',[process.env.ADMIN_USERNAME]);
  if (!existing) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await run('INSERT INTO admins(username,password_hash) VALUES(?,?)',[process.env.ADMIN_USERNAME,hash]);
    console.log('Initial admin account created from environment variables.');
  }
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({limit:'100kb'}));
app.use(express.urlencoded({extended:false}));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.dirname(DB_PATH) }),
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly:true, secure: process.env.NODE_ENV === 'production', sameSite:'lax', maxAge: 8*60*60*1000 }
}));
const loginLimiter = rateLimit({windowMs:15*60*1000, limit:10, standardHeaders:true, legacyHeaders:false});
const orderLimiter = rateLimit({windowMs:60*60*1000, limit:30, standardHeaders:true, legacyHeaders:false});
const requireAdmin = (req,res,next)=>req.session && req.session.admin ? next() : res.status(401).json({error:'लॉगिन आवश्यक है।'});
app.get('/health',(req,res)=>res.json({ok:true}));
app.use(express.static(path.join(__dirname,'public')));

app.get('/api/products', async (req,res)=>{
  try { res.json(await all('SELECT id,name_hi,name_en,price,unit,category FROM products WHERE active=1 ORDER BY category,name_hi')); }
  catch(e){res.status(500).json({error:'सामान लोड नहीं हो सका।'});}
});
app.post('/api/orders', orderLimiter, async (req,res)=>{
  try {
    const {customer,items,payment_method} = req.body || {};
    if (!customer || !Array.isArray(items) || !items.length || items.length>100) return res.status(400).json({error:'ऑर्डर की जानकारी अधूरी है।'});
    const name=String(customer.name||'').trim(), phone=String(customer.phone||'').replace(/\D/g,''), village=String(customer.village||'').trim(), address=String(customer.address||'').trim();
    if (!name || phone.length!==10 || !village || !address) return res.status(400).json({error:'नाम, 10 अंकों का मोबाइल, गांव और पता सही भरें।'});
    let subtotal=0, checked=[];
    for (const item of items) {
      const id=Number(item.id), qty=Number(item.quantity);
      if (!Number.isInteger(id)||!Number.isInteger(qty)||qty<1||qty>99) return res.status(400).json({error:'सामान की मात्रा सही नहीं है।'});
      const product=await get('SELECT id,name_hi,price FROM products WHERE id=? AND active=1',[id]);
      if (!product) return res.status(400).json({error:'चुना हुआ सामान उपलब्ध नहीं है। पेज रीफ्रेश करें।'});
      subtotal += product.price*qty; checked.push({...product,quantity:qty});
    }
    const delivery_fee=subtotal>500?0:10, total=Number((subtotal+delivery_fee).toFixed(2));
    const order_no='JAY-'+Date.now().toString().slice(-8);
    const result=await run('INSERT INTO orders(order_no,customer_name,phone,village,address,subtotal,delivery_fee,total,payment_method) VALUES(?,?,?,?,?,?,?,?,?)',[order_no,name,phone,village,address,subtotal,delivery_fee,total,String(payment_method||'कैश ऑन डिलीवरी')]);
    for (const p of checked) await run('INSERT INTO order_items(order_id,product_id,product_name,price,quantity) VALUES(?,?,?,?,?)',[result.lastID,p.id,p.name_hi,p.price,p.quantity]);
    res.status(201).json({ok:true,order_no,subtotal,delivery_fee,total,items:checked});
  } catch(e){console.error(e);res.status(500).json({error:'ऑर्डर सेव नहीं हो सका। कृपया दोबारा प्रयास करें।'});}
});

app.post('/api/admin/login', loginLimiter, async (req,res)=>{
  try {
    const username=String(req.body.username||''), password=String(req.body.password||'');
    const admin=await get('SELECT * FROM admins WHERE username=?',[username]);
    if (!admin || !(await bcrypt.compare(password,admin.password_hash))) return res.status(401).json({error:'यूज़रनेम या पासवर्ड गलत है।'});
    req.session.admin={id:admin.id,username:admin.username};
    res.json({ok:true,username:admin.username});
  } catch(e){res.status(500).json({error:'लॉगिन नहीं हो सका।'});}
});
app.post('/api/admin/logout',requireAdmin,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/me',requireAdmin,(req,res)=>res.json({username:req.session.admin.username}));
app.get('/api/admin/orders',requireAdmin,async(req,res)=>{
  try {
    const orders=await all('SELECT * FROM orders ORDER BY id DESC LIMIT 200');
    for(const o of orders) o.items=await all('SELECT product_name,price,quantity FROM order_items WHERE order_id=?',[o.id]);
    res.json(orders);
  }catch(e){res.status(500).json({error:'ऑर्डर लोड नहीं हो सके।'});}
});
app.patch('/api/admin/orders/:id',requireAdmin,async(req,res)=>{
  const allowed=['नया','स्वीकृत','तैयार','डिलीवरी के लिए निकला','डिलीवर','रद्द'];
  const status=String(req.body.status||'');
  if(!allowed.includes(status)) return res.status(400).json({error:'स्थिति मान्य नहीं है।'});
  try{const r=await run('UPDATE orders SET status=? WHERE id=?',[status,Number(req.params.id)]); if(!r.changes)return res.status(404).json({error:'ऑर्डर नहीं मिला।'});res.json({ok:true});}
  catch(e){res.status(500).json({error:'स्थिति अपडेट नहीं हुई।'});}
});
app.post('/api/admin/products',requireAdmin,async(req,res)=>{
  const {name_hi,name_en='',price,unit='',category='अन्य'}=req.body||{};
  if(!String(name_hi||'').trim() || !Number.isFinite(Number(price)) || Number(price)<0) return res.status(400).json({error:'सामान का नाम और सही कीमत भरें।'});
  try{const r=await run('INSERT INTO products(name_hi,name_en,price,unit,category) VALUES(?,?,?,?,?)',[String(name_hi).trim(),String(name_en).trim(),Number(price),String(unit),String(category)]);res.status(201).json({id:r.lastID});}
  catch(e){res.status(500).json({error:'सामान सेव नहीं हुआ।'});}
});
app.patch('/api/admin/products/:id',requireAdmin,async(req,res)=>{
  const {name_hi,name_en='',price,unit='',category='अन्य',active=1}=req.body||{};
  if(!String(name_hi||'').trim() || !Number.isFinite(Number(price)) || Number(price)<0) return res.status(400).json({error:'सामान का नाम और सही कीमत भरें।'});
  try{await run('UPDATE products SET name_hi=?,name_en=?,price=?,unit=?,category=?,active=? WHERE id=?',[String(name_hi).trim(),String(name_en).trim(),Number(price),String(unit),String(category),active?1:0,Number(req.params.id)]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'सामान अपडेट नहीं हुआ।'});}
});
app.delete('/api/admin/products/:id',requireAdmin,async(req,res)=>{
  try{await run('UPDATE products SET active=0 WHERE id=?',[Number(req.params.id)]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'सामान हटाया नहीं जा सका।'});}
});
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
init().then(()=>app.listen(PORT,()=>console.log(`Jay Enterprises server listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
