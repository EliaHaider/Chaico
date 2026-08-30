// ============================================================================
// Chaico mobile data engine.
// Reimplements the original desktop app's db.js (which used better-sqlite3
// inside Electron's main process) using sql.js — a WASM build of SQLite that
// runs directly inside the WebView. The exposed window.api surface matches
// the original preload.js exactly, so app.js (the UI) runs completely
// unmodified.
//
// The database itself is a real SQLite file (same schema, same table names,
// same column names as chaico_data.db from the desktop app), kept in memory
// and persisted to the device via IndexedDB after every write. Settings has
// Import/Export buttons to load or save that .db file directly, so a backup
// taken from the desktop app opens here with zero conversion.
// ============================================================================

(function () {
  const DB_STORE_NAME = 'chaico-store';
  const DB_KEY = 'chaico_db_bytes';
  // Real on-device file, so a backup can be copied in directly with a file
  // manager or over USB — same path structure a canteen owner can navigate
  // to from a PC. Lives at: /storage/emulated/0/Documents/Chaico/chaico_data.db
  const FS_DIR = 'DOCUMENTS';
  const FS_FOLDER = 'Chaico';
  const FS_PATH = 'Chaico/chaico_data.db';
  const FRIENDLY_PATH = 'Internal Storage / Documents / Chaico / chaico_data.db';
  let SQL = null;
  let db = null;
  let saveTimer = null;

  // ---------- tiny IndexedDB key/value helper (fallback cache) ----------
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_STORE_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const conn = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction('kv', 'readonly');
      const rq = tx.objectStore('kv').get(key);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  async function idbSet(key, value) {
    const conn = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------- real device file, via Capacitor Filesystem plugin ----------
  function getFilesystemPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) || null;
  }
  async function ensureStoragePermission(Filesystem) {
    try {
      if (!Filesystem.checkPermissions) return;
      const status = await Filesystem.checkPermissions();
      if (status && status.publicStorage && status.publicStorage !== 'granted') {
        await Filesystem.requestPermissions();
      }
    } catch (e) { /* older Android / scoped storage doesn't need this — fine either way */ }
  }
  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }
  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  async function fsReadDb() {
    const Filesystem = getFilesystemPlugin();
    if (!Filesystem) return null;
    try {
      await ensureStoragePermission(Filesystem);
      const res = await Filesystem.readFile({ path: FS_PATH, directory: FS_DIR });
      return base64ToBytes(res.data);
    } catch (e) { return null; } // file doesn't exist yet — normal on first run
  }
  async function fsWriteDb(bytes) {
    const Filesystem = getFilesystemPlugin();
    if (!Filesystem) return false;
    try {
      await ensureStoragePermission(Filesystem);
      await Filesystem.mkdir({ path: FS_FOLDER, directory: FS_DIR, recursive: true }).catch(() => {});
      await Filesystem.writeFile({ path: FS_PATH, directory: FS_DIR, data: bytesToBase64(bytes) });
      return true;
    } catch (e) { console.error('Chaico: could not write chaico_data.db', e); return false; }
  }

  function persist() {
    // Debounced save so rapid successive writes (e.g. a multi-line sale)
    // don't serialize the whole DB to bytes over and over.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const bytes = db.export();
        await fsWriteDb(bytes);   // real file — same one you can copy over USB / file manager
        await idbSet(DB_KEY, bytes); // fast local cache fallback
      } catch (e) { console.error('Chaico: save failed', e); }
    }, 150);
  }

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL,
      category TEXT DEFAULT '',
      unit_label TEXT DEFAULT 'pcs',
      price REAL DEFAULT 0,
      box_cost REAL DEFAULT 0,
      pieces_per_box REAL DEFAULT 0,
      stock REAL DEFAULT 0,
      ingredients_json TEXT DEFAULT '[]',
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      date TEXT, time TEXT,
      item_id TEXT, item_name TEXT,
      qty REAL,
      unit_price REAL, total REAL,
      unit_cost REAL, total_cost REAL, profit REAL,
      paid INTEGER, customer_name TEXT
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY, date TEXT, time TEXT, name TEXT, amount REAL
    );
    CREATE TABLE IF NOT EXISTS debts (
      id TEXT PRIMARY KEY, name TEXT, balance REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS debt_history (
      id TEXT PRIMARY KEY, debt_id TEXT, date TEXT, time TEXT, amount REAL, type TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT
    );
  `;

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function timeStr() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  // ---------- thin sql.js query helpers ----------
  function run(sql, params = []) { db.run(sql, params); }
  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }
  function get(sql, params = []) { const r = all(sql, params); return r[0]; }

  async function initDb() {
    if (!SQL) {
      SQL = await initSqlJs({ locateFile: f => 'vendor/' + f });
    }
    // Priority: 1) real file on device (so a backup dropped in via USB/file
    // manager before first launch is picked up automatically), 2) IndexedDB
    // cache (covers upgrades from an older version of the app), 3) fresh DB.
    let bytes = await fsReadDb();
    let fromLegacyCache = false;
    if (!bytes) {
      const saved = await idbGet(DB_KEY).catch(() => null);
      if (saved) { bytes = new Uint8Array(saved); fromLegacyCache = true; }
    }
    db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    db.run(SCHEMA);
    migrateItemsTable();
    if (fromLegacyCache || !bytes) await fsWriteDb(db.export()); // make sure the real file exists from now on
    persist();
  }

  function migrateItemsTable() {
    const cols = all("PRAGMA table_info(items)").map(c => c.name);
    const hasCol = c => cols.includes(c);
    if (!hasCol('unit_label')) run("ALTER TABLE items ADD COLUMN unit_label TEXT DEFAULT 'pcs'");
    if (!hasCol('price')) run("ALTER TABLE items ADD COLUMN price REAL DEFAULT 0");
    if (!hasCol('box_cost')) run("ALTER TABLE items ADD COLUMN box_cost REAL DEFAULT 0");
    if (!hasCol('pieces_per_box')) run("ALTER TABLE items ADD COLUMN pieces_per_box REAL DEFAULT 0");
    if (!hasCol('stock')) run("ALTER TABLE items ADD COLUMN stock REAL DEFAULT 0");
    if (!hasCol('ingredients_json')) run("ALTER TABLE items ADD COLUMN ingredients_json TEXT DEFAULT '[]'");
    if (!hasCol('category')) run("ALTER TABLE items ADD COLUMN category TEXT DEFAULT ''");
    const dhCols = all("PRAGMA table_info(debt_history)").map(c => c.name);
    if (!dhCols.includes('time')) run("ALTER TABLE debt_history ADD COLUMN time TEXT DEFAULT ''");
  }

  // ---------- settings ----------
  function getSetting(key, def) { const r = get('SELECT value FROM settings WHERE key=?', [key]); return r ? r.value : def; }
  function setSetting(key, value) {
    run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
    persist();
  }

  // ---------- items ----------
  function rowToItem(r) { return { ...r, ingredients: JSON.parse(r.ingredients_json || '[]') }; }
  function getItems() { return all('SELECT * FROM items ORDER BY name').map(rowToItem); }
  function itemCost(item) {
    if (item.mode === 'recipe') return (item.ingredients || []).reduce((s, i) => s + (Number(i.cost) || 0), 0);
    const box = Number(item.box_cost) || 0, pcs = Number(item.pieces_per_box) || 0;
    return pcs > 0 ? box / pcs : 0;
  }
  function saveItem(item) {
    const id = item.id || uid();
    const ingredientsJson = JSON.stringify(item.ingredients || []);
    const existing = get('SELECT id FROM items WHERE id=?', [id]);
    const vals = [item.name, item.mode, item.category || '', item.unit_label || 'pcs', item.price || 0,
      item.box_cost || 0, item.pieces_per_box || 0, item.stock || 0, ingredientsJson];
    if (existing) {
      run(`UPDATE items SET name=?, mode=?, category=?, unit_label=?, price=?, box_cost=?, pieces_per_box=?, stock=?, ingredients_json=? WHERE id=?`, [...vals, id]);
    } else {
      run(`INSERT INTO items(id,name,mode,category,unit_label,price,box_cost,pieces_per_box,stock,ingredients_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, ...vals, new Date().toISOString()]);
    }
    persist();
    return id;
  }
  function deleteItem(id) { run('DELETE FROM items WHERE id=?', [id]); persist(); }
  function restock(id, addPieces) {
    const n = Number(addPieces);
    if (!isFinite(n)) return;
    run('UPDATE items SET stock = MAX(0, stock + ?) WHERE id=?', [n, id]);
    persist();
  }

  // ---------- sales ----------
  function recordSale(lines, paid, customerName, customTime) {
    const date = todayStr(), time = customTime || timeStr();
    let total = 0;
    for (const line of lines) {
      const item = rowToItem(get('SELECT * FROM items WHERE id=?', [line.itemId]));
      const unitCost = itemCost(item);
      const unitPrice = item.price;
      const lineTotal = unitPrice * line.qty;
      const lineCost = unitCost * line.qty;
      total += lineTotal;
      run(`INSERT INTO sales(id,date,time,item_id,item_name,qty,unit_price,total,unit_cost,total_cost,profit,paid,customer_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uid(), date, time, item.id, item.name, line.qty, unitPrice, lineTotal, unitCost, lineCost, lineTotal - lineCost, paid ? 1 : 0, customerName || null]);
      if (item.mode !== 'recipe') run('UPDATE items SET stock = MAX(0, stock - ?) WHERE id=?', [line.qty, item.id]);
    }
    if (!paid && customerName) {
      let person = get('SELECT * FROM debts WHERE LOWER(name)=LOWER(?)', [customerName.trim()]);
      if (!person) {
        const id = uid();
        run('INSERT INTO debts(id,name,balance) VALUES (?,?,0)', [id, customerName.trim()]);
        person = { id, name: customerName.trim(), balance: 0 };
      }
      run('UPDATE debts SET balance = balance + ? WHERE id=?', [total, person.id]);
      run('INSERT INTO debt_history(id,debt_id,date,time,amount,type,note) VALUES (?,?,?,?,?,?,?)',
        [uid(), person.id, date, time, total, 'credit', 'Order: ' + lines.map(l => l.name + ' x' + l.qty).join(', ')]);
    }
    persist();
  }
  function getSalesForDate(date) { return all('SELECT * FROM sales WHERE date=? ORDER BY time DESC', [date]); }
  function deleteSale(saleId) {
    const sale = get('SELECT * FROM sales WHERE id=?', [saleId]);
    if (!sale) return false;
    const item = get('SELECT * FROM items WHERE id=?', [sale.item_id]);
    if (item && item.mode !== 'recipe') run('UPDATE items SET stock = stock + ? WHERE id=?', [sale.qty, item.id]);
    if (!sale.paid && sale.customer_name) {
      const person = get('SELECT * FROM debts WHERE LOWER(name)=LOWER(?)', [sale.customer_name.trim()]);
      if (person) {
        run('UPDATE debts SET balance = MAX(0, balance - ?) WHERE id=?', [sale.total, person.id]);
        run('INSERT INTO debt_history(id,debt_id,date,time,amount,type,note) VALUES (?,?,?,?,?,?,?)',
          [uid(), person.id, todayStr(), timeStr(), -sale.total, 'reversal', 'Order cancelled/refunded: ' + sale.item_name]);
      }
    }
    run('DELETE FROM sales WHERE id=?', [saleId]);
    persist();
    return true;
  }

  function daySummary(date) {
    const sales = getSalesForDate(date);
    const exp = getExpensesForDate(date);
    const totalSales = sales.reduce((s, x) => s + x.total, 0);
    const totalCost = sales.reduce((s, x) => s + x.total_cost, 0);
    const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
    const cashIn = sales.filter(x => x.paid).reduce((s, x) => s + x.total, 0);
    const unpaid = sales.filter(x => !x.paid).reduce((s, x) => s + x.total, 0);
    const totalExpenses = exp.reduce((s, x) => s + Number(x.amount || 0), 0);
    const byItem = {};
    sales.forEach(s => { byItem[s.item_name] = byItem[s.item_name] || { qty: 0, total: 0 }; byItem[s.item_name].qty += s.qty; byItem[s.item_name].total += s.total; });
    return { date, totalSales, totalCost, totalProfit, cashIn, unpaid, totalExpenses, expectedCash: cashIn - totalExpenses, byItem, count: sales.length };
  }
  function getRangeSummary(startDate, endDate) {
    const dates = [];
    let d = new Date(startDate);
    const end = new Date(endDate);
    while (d <= end) { dates.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
    return dates.map(daySummary);
  }
  function getMonthProfit(monthKey) {
    const row = get("SELECT SUM(profit) as p FROM sales WHERE date LIKE ?", [monthKey + '%']);
    return (row && row.p) || 0;
  }

  // ---------- expenses ----------
  function getExpensesForDate(date) { return all('SELECT * FROM expenses WHERE date=? ORDER BY time', [date]); }
  function addExpense(name, amount) { run('INSERT INTO expenses(id,date,time,name,amount) VALUES (?,?,?,?,?)', [uid(), todayStr(), timeStr(), name, amount]); persist(); }
  function deleteExpense(id) { run('DELETE FROM expenses WHERE id=?', [id]); persist(); }

  // ---------- debts ----------
  function getDebts() { return all('SELECT * FROM debts ORDER BY balance DESC'); }
  function addDebtPerson(name) { const id = uid(); run('INSERT INTO debts(id,name,balance) VALUES (?,?,0)', [id, name.trim()]); persist(); return id; }
  function payDebt(id, amount) {
    run('UPDATE debts SET balance = MAX(0, balance - ?) WHERE id=?', [amount, id]);
    run('INSERT INTO debt_history(id,debt_id,date,time,amount,type,note) VALUES (?,?,?,?,?,?,?)', [uid(), id, todayStr(), timeStr(), -amount, 'payment', 'Payment received']);
    persist();
  }
  function addDebtManual(id, amount) {
    run('UPDATE debts SET balance = balance + ? WHERE id=?', [amount, id]);
    run('INSERT INTO debt_history(id,debt_id,date,time,amount,type,note) VALUES (?,?,?,?,?,?,?)', [uid(), id, todayStr(), timeStr(), amount, 'udhar', 'Manual add']);
    persist();
  }
  function deleteDebtPerson(id) { run('DELETE FROM debts WHERE id=?', [id]); run('DELETE FROM debt_history WHERE debt_id=?', [id]); persist(); }
  function getDebtHistory(id) { return all('SELECT * FROM debt_history WHERE debt_id=? ORDER BY date DESC, time DESC', [id]); }
  function renameCategory(oldName, newName) {
    all("SELECT id FROM items WHERE category=?", [oldName]).forEach(r => run('UPDATE items SET category=? WHERE id=?', [newName, r.id]));
    persist();
  }

  // ---------- backup import / export (the whole point: same .db file) ----------
  async function exportDbBytes() { return db.export(); }
  async function importDbBytes(bytes) {
    db = new SQL.Database(new Uint8Array(bytes));
    db.run(SCHEMA); // ensure any missing tables exist, never destroys existing data
    migrateItemsTable();
    await idbSet(DB_KEY, bytes);
  }

  const ready = initDb();

  // Wrap every function as an async IPC-style call, exactly matching the
  // original preload.js surface, so app.js needs zero changes.
  function wrap(fn) { return async (...args) => { await ready; return fn(...args); }; }

  window.api = {
    getSetting: wrap(getSetting), setSetting: wrap(setSetting),
    getItems: wrap(getItems), saveItem: wrap(saveItem), deleteItem: wrap(deleteItem), restock: wrap(restock),
    recordSale: wrap(recordSale), daySummary: wrap(daySummary), getSalesForDate: wrap(getSalesForDate),
    deleteSale: wrap(deleteSale), getRangeSummary: wrap(getRangeSummary), getMonthProfit: wrap(getMonthProfit),
    getExpensesForDate: wrap(getExpensesForDate), addExpense: wrap(addExpense), deleteExpense: wrap(deleteExpense),
    getDebts: wrap(getDebts), addDebtPerson: wrap(addDebtPerson), payDebt: wrap(payDebt),
    addDebtManual: wrap(addDebtManual), deleteDebtPerson: wrap(deleteDebtPerson), getDebtHistory: wrap(getDebtHistory),
    getDbPath: wrap(() => FRIENDLY_PATH),
    todayStr: wrap(todayStr),
    renameCategory: wrap(renameCategory),
    // extra, mobile-only:
    exportDbBytes: wrap(exportDbBytes),
    importDbBytes: async (bytes) => { await ready; return importDbBytes(bytes); }
  };
  window.chaicoReady = ready;
})();
