(function () {
  const api = window.api;
  let items = [];
  let cart = []; // {itemId,name,qty,unitPrice}
  let activeTab = 'pos';
  let today = '';
  let lastSelectedItemId = null;
  let currentDebts = [];

  const fmt = n => 'Rs ' + Math.round(n).toLocaleString('en-IN');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowHHMM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const anyModalOpen = () => !!document.querySelector('.modal-bg');

  // ================= CUSTOM DIALOGS =================
  // Electron does not support window.prompt() — using it throws and can leave
  // the UI in a broken state. These custom modals replace alert/confirm/prompt
  // everywhere in the app.
  function showAlert(message, title) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-bg';
      wrap.innerHTML = `<div class="modal small-modal"><h2>${esc(title || 'Chaico')}</h2><p>${esc(message)}</p>
        <div class="cart-actions"><button class="primary" id="dlg-ok">OK</button></div></div>`;
      document.body.appendChild(wrap);
      const close = () => { wrap.remove(); resolve(); };
      wrap.querySelector('#dlg-ok').onclick = close;
      setTimeout(() => wrap.querySelector('#dlg-ok').focus(), 20);
    });
  }
  function showConfirm(message, title) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-bg';
      wrap.innerHTML = `<div class="modal small-modal"><h2>${esc(title || 'Please Confirm')}</h2><p>${esc(message)}</p>
        <div class="cart-actions"><button class="warn" id="dlg-yes">Yes</button><button class="ghost" id="dlg-no">Cancel</button></div></div>`;
      document.body.appendChild(wrap);
      const close = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('#dlg-yes').onclick = () => close(true);
      wrap.querySelector('#dlg-no').onclick = () => close(false);
    });
  }
  function showNumberPrompt({ title, label, placeholder }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-bg';
      wrap.innerHTML = `<div class="modal small-modal"><h2>${esc(title || 'Enter Amount')}</h2>
        ${label ? `<label>${esc(label)}</label>` : ''}
        <input id="dlg-input" type="number" placeholder="${esc(placeholder || '')}">
        <div class="cart-actions"><button class="primary" id="dlg-ok">OK</button><button class="ghost" id="dlg-cancel">Cancel</button></div></div>`;
      document.body.appendChild(wrap);
      const input = wrap.querySelector('#dlg-input');
      setTimeout(() => input.focus(), 20);
      const close = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('#dlg-ok').onclick = () => close(input.value === '' ? null : Number(input.value));
      wrap.querySelector('#dlg-cancel').onclick = () => close(null);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') close(input.value === '' ? null : Number(input.value));
        if (e.key === 'Escape') close(null);
      });
    });
  }

  function nameDatalist(names, id) {
    const uniq = [...new Set(names.filter(Boolean))];
    return `<datalist id="${id}">${uniq.map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
  }

  // Wraps an async click handler so a thrown error shows a message instead
  // of leaving the button (and everything after it) unresponsive.
  function safe(fn) {
    return async (...args) => {
      try { await fn(...args); }
      catch (err) {
        console.error(err);
        await showAlert(err && err.message ? err.message : String(err));
      }
    };
  }
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled error:', e.reason);
    showAlert(e.reason && e.reason.message ? e.reason.message : String(e.reason));
    e.preventDefault();
  });

  const NAV = [
    { id: 'pos', ic: '🛒', label: 'Sales' },
    { id: 'items', ic: '📦', label: 'Inventory' },
    { id: 'credit', ic: '🤝', label: 'Credit' },
    { id: 'expenses', ic: '💸', label: 'Expenses' },
    { id: 'reports', ic: '📊', label: 'Reports' },
    { id: 'settings', ic: '⚙️', label: 'Settings' }
  ];

  async function boot() {
    today = await api.todayStr();
    const theme = await api.getSetting('theme', 'light');
    document.documentElement.dataset.theme = theme;
    updateThemeUI(theme);
    document.getElementById('themeSwitch').onclick = safe(async () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      updateThemeUI(next);
      await api.setSetting('theme', next);
    });
    // Click the logo for a full "deep refresh" if the app ever seems stuck.
    const logo = document.querySelector('.logo');
    logo.style.cursor = 'pointer';
    logo.title = 'Click to refresh Chaico';
    logo.onclick = () => location.reload();

    renderNav();
    items = await api.getItems();
    await renderTab();

    document.addEventListener('keydown', safe(async (e) => {
      if (activeTab !== 'pos') return;
      if (anyModalOpen()) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (!lastSelectedItemId) return;
      const item = items.find(i => i.id === lastSelectedItemId);
      if (!item) return;
      e.preventDefault();
      const line = cart.find(c => c.itemId === lastSelectedItemId);
      if (e.key === 'ArrowUp') {
        addToCart(item);
        await renderTab();
      } else if (e.key === 'ArrowDown' && line) {
        line.qty--;
        if (line.qty <= 0) cart = cart.filter(c => c !== line);
        await renderTab();
      }
    }));
  }
  function updateThemeUI(theme) {
    document.getElementById('themeLabel').textContent = theme === 'light' ? 'Light Mode' : 'Dark Mode';
  }

  function renderNav() {
    const nav = document.getElementById('navSide');
    nav.innerHTML = NAV.map(n => `<button data-tab="${n.id}" class="${activeTab === n.id ? 'active' : ''}"><span class="ic">${n.ic}</span>${n.label}</button>`).join('');
    nav.querySelectorAll('button').forEach(b => b.onclick = safe(async () => { activeTab = b.dataset.tab; renderNav(); await renderTab(); }));
  }

  async function renderTab() {
    const main = document.getElementById('main');
    if (activeTab === 'pos') { main.innerHTML = await posTab(); wirePos(); }
    if (activeTab === 'items') { main.innerHTML = itemsTab(); wireItems(); }
    if (activeTab === 'credit') { main.innerHTML = await creditTab(); wireCredit(); }
    if (activeTab === 'expenses') { main.innerHTML = await expensesTab(); wireExpenses(); }
    if (activeTab === 'reports') { main.innerHTML = await reportsTab(); await drawCharts(); }
    if (activeTab === 'settings') { main.innerHTML = await settingsTab(); wireSettings(); }
  }

  // ---------- shared helpers ----------
  function itemUnitCost(it) { return it.mode === 'recipe' ? it.ingredients.reduce((s, i) => s + (Number(i.cost) || 0), 0) : ((it.pieces_per_box > 0) ? (it.box_cost / it.pieces_per_box) : 0); }
  function categoryOf(it) { return it.mode === 'recipe' ? 'Homemade' : ((it.category && it.category.trim()) || 'Other'); }
  function groupByCategory(list) {
    const groups = {};
    list.forEach(it => { const c = categoryOf(it); groups[c] = groups[c] || []; groups[c].push(it); });
    const order = Object.keys(groups).sort((a, b) => a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b));
    return order.map(name => ({ name, items: groups[name] }));
  }
  function categorySuggestions() {
    const existing = items.filter(i => i.mode !== 'recipe').map(i => i.category).filter(Boolean);
    return [...new Set(['Packs', 'Bottles', 'Snacks', 'Drinks', ...existing])];
  }
  function addToCart(item) {
    if (item.mode !== 'recipe') {
      const line = cart.find(c => c.itemId === item.id);
      const currentQty = line ? line.qty : 0;
      if (currentQty + 1 > item.stock) return false;
    }
    let line = cart.find(c => c.itemId === item.id);
    if (line) line.qty++;
    else cart.push({ itemId: item.id, name: item.name, qty: 1, unitPrice: Number(item.price) || 0 });
    lastSelectedItemId = item.id;
    return true;
  }

  // ================= SALES (POS) =================
  async function posTab() {
    const s = await api.daySummary(today);
    const todaysSales = await api.getSalesForDate(today);
    currentDebts = await api.getDebts();
    const realProfitHtml = await realProfitLine(s.totalProfit);

    const groups = groupByCategory(items);
    const tilesHtml = groups.map(g => `
      <h3 class="section cat-heading">${esc(g.name)}</h3>
      <div class="item-grid">
        ${g.items.map(it => {
          const inCart = cart.filter(c => c.itemId === it.id).reduce((a, c) => a + c.qty, 0);
          const outOfStock = it.mode !== 'recipe' && it.stock <= 0;
          const low = it.mode !== 'recipe' && it.stock > 0 && it.stock <= 3;
          return `<div class="item-tile ${low ? 'low' : ''} ${outOfStock ? 'disabled' : ''}" ${outOfStock ? '' : `data-add="${it.id}"`}>
            ${inCart ? `<div class="badge">${inCart}</div>` : ''}
            <div class="nm">${esc(it.name)}</div>
            <div class="stk">${it.mode === 'recipe' ? 'Made to order' : (outOfStock ? 'Out of stock' : it.stock + ' ' + esc(it.unit_label) + ' left')}</div>
            <div class="tile-price">${fmt(it.price)}</div>
          </div>`;
        }).join('')}
      </div>`).join('');

    const cartRows = cart.map((c, idx) => `
      <div class="cart-row">
        <div>${esc(c.name)}</div>
        <div class="qty-ctl">
          <button data-dec="${idx}">−</button>
          <span>${c.qty}</span>
          <button data-inc="${idx}">+</button>
          <span style="width:75px;text-align:right;">${fmt(c.qty * c.unitPrice)}</span>
          <button data-rm="${idx}" style="border:none;background:none;color:var(--danger);font-weight:800;cursor:pointer;">✕</button>
        </div>
      </div>`).join('');
    const total = cart.reduce((s2, c) => s2 + c.qty * c.unitPrice, 0);

    const orderRows = todaysSales.slice(0, 30).map(sl => `
      <tr>
        <td>${sl.time}</td>
        <td>${esc(sl.item_name)} <span class="muted">x${sl.qty}</span></td>
        <td>${fmt(sl.total)}</td>
        <td><span class="pill ${sl.paid ? 'paid' : 'unpaid'}">${sl.paid ? 'Paid' : 'Credit'}</span></td>
        <td><button class="ghost small" data-void="${sl.id}">Delete</button></td>
      </tr>`).join('');

    return `
      <div class="pagehead"><div><h2>Sales</h2><p>Tap an item to start an order · use ↑ ↓ to adjust the last one</p></div></div>
      <div class="grid-stats">
        <div class="stat good"><div class="label">Today's Sales</div><div class="value">${fmt(s.totalSales)}</div><div class="sub">${s.count} orders</div></div>
        <div class="stat good"><div class="label">Today's Profit</div>${realProfitHtml}<div class="value">${fmt(s.totalProfit)}</div></div>
        <div class="stat"><div class="label">Cash Expected in Counter</div><div class="value">${fmt(s.expectedCash)}</div></div>
        <div class="stat bad"><div class="label">Today's Credit</div><div class="value">${fmt(s.unpaid)}</div></div>
      </div>
      <div class="cart-float" id="cartFloat" style="display:${cart.length ? 'flex' : 'none'};">
        🛒 <span>${fmt(cart.reduce((s2, c) => s2 + c.qty * c.unitPrice, 0))}</span> <span class="muted">(${cart.reduce((s2, c) => s2 + c.qty, 0)})</span>
      </div>
      <div class="card">
        <h3 class="section">🍽️ Items</h3>
        ${items.length ? tilesHtml : `<div class="empty">No items yet. Go to "Inventory" to add your first item.</div>`}
      </div>
      ${cart.length ? `<div class="cart">
        <h3 class="section" style="margin-top:0;">Current Order</h3>
        ${cartRows}
        <div class="cart-total"><span>Total</span><span>${fmt(total)}</span></div>
        <div class="field" style="margin-top:12px;">
          <label>Customer / Staff name (required for credit)</label>
          <input id="custName" list="dl-pos-names" placeholder="Leave blank if paying cash">
          ${nameDatalist(currentDebts.map(d => d.name), 'dl-pos-names')}
        </div>
        <div class="cart-actions">
          <button class="primary" id="btnDone">✓ Mark as Paid</button>
          <button class="warn" id="btnNotDone">Add to Credit</button>
          <button class="ghost" id="btnClearCart">Clear Order</button>
        </div>
      </div>` : ''}
      <div class="card">
        <div class="pagehead" style="margin-bottom:6px;">
          <div><h3 class="section" style="margin:0;">Today's Orders</h3></div>
          <button class="ghost small" id="btnManualOrder">+ Add Past Order</button>
        </div>
        <p class="muted" style="margin-top:0;">Made a mistake, or a customer returned an item? Delete that order here.</p>
        ${todaysSales.length ? `<table><tr><th>Time</th><th>Item</th><th>Amount</th><th>Status</th><th></th></tr>${orderRows}</table>` : `<div class="empty">No orders yet today.</div>`}
      </div>
    `;
  }

  function wirePos() {
    const cartFloat = document.getElementById('cartFloat');
    if (cartFloat) cartFloat.onclick = () => { const c = document.querySelector('.cart'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    document.querySelectorAll('[data-add]').forEach(el => {
      el.onclick = safe(async () => {
        const id = el.dataset.add;
        const item = items.find(i => i.id === id);
        if (!item) return;
        addToCart(item);
        await renderTab();
      });
    });
    document.querySelectorAll('[data-inc]').forEach(el => el.onclick = safe(async () => {
      const c = cart[el.dataset.inc];
      const item = items.find(i => i.id === c.itemId);
      if (item) addToCart(item);
      await renderTab();
    }));
    document.querySelectorAll('[data-dec]').forEach(el => el.onclick = safe(async () => {
      const idx = Number(el.dataset.dec); cart[idx].qty--;
      if (cart[idx].qty <= 0) cart.splice(idx, 1);
      await renderTab();
    }));
    document.querySelectorAll('[data-rm]').forEach(el => el.onclick = safe(async () => { cart.splice(Number(el.dataset.rm), 1); await renderTab(); }));
    const clearBtn = document.getElementById('btnClearCart');
    if (clearBtn) clearBtn.onclick = safe(async () => { cart = []; await renderTab(); });
    const doneBtn = document.getElementById('btnDone');
    if (doneBtn) doneBtn.onclick = safe(() => completeSale(true));
    const notDoneBtn = document.getElementById('btnNotDone');
    if (notDoneBtn) notDoneBtn.onclick = safe(() => completeSale(false));
    document.querySelectorAll('[data-void]').forEach(el => el.onclick = safe(async () => {
      if (!(await showConfirm('Delete this order? This will restore stock and reverse any credit.'))) return;
      await api.deleteSale(el.dataset.void);
      items = await api.getItems();
      await renderTab();
    }));
    const manualBtn = document.getElementById('btnManualOrder');
    if (manualBtn) manualBtn.onclick = () => manualOrderModal();
  }

  async function completeSale(paid) {
    const nameInput = document.getElementById('custName');
    const custName = nameInput ? nameInput.value.trim() : '';
    if (!paid && !custName) { await showAlert('Please enter a name to record this as credit.'); return; }
    await api.recordSale(cart.map(c => ({ itemId: c.itemId, name: c.name, qty: c.qty })), paid, custName);
    cart = [];
    items = await api.getItems();
    await renderTab();
  }

  function manualOrderModal() {
    if (anyModalOpen()) return;
    let draftLines = [];
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.innerHTML = `
      <div class="modal">
        <button class="close-x">&times;</button>
        <h2>Add Past Order</h2>
        <p class="muted">For an order you forgot to log earlier today.</p>
        <div class="row3">
          <div class="field" style="grid-column:span 2;"><label>Item</label>
            <select id="mo-item">${items.map(i => `<option value="${i.id}">${esc(i.name)} — ${fmt(i.price)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Qty</label><input id="mo-qty" type="number" value="1" min="1"></div>
        </div>
        <button type="button" class="ghost small" id="mo-addline">+ Add to Order</button>
        <div id="mo-lines" style="margin:12px 0;"></div>
        <div class="row2">
          <div class="field"><label>Time</label><input id="mo-time" type="time" value="${nowHHMM()}"></div>
          <div class="field"><label>Status</label>
            <select id="mo-status"><option value="paid">Paid</option><option value="credit">Credit</option></select>
          </div>
        </div>
        <div class="field" id="mo-name-wrap" style="display:none;">
          <label>Customer name</label>
          <input id="mo-name" list="dl-manual-names" placeholder="Name">
          ${nameDatalist(currentDebts.map(d => d.name), 'dl-manual-names')}
        </div>
        <div class="cart-actions">
          <button class="primary" id="mo-submit">Save Order</button>
          <button class="ghost" id="mo-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.close-x').onclick = close;
    wrap.querySelector('#mo-cancel').onclick = close;
    wrap.querySelector('#mo-status').onchange = (e) => {
      wrap.querySelector('#mo-name-wrap').style.display = e.target.value === 'credit' ? '' : 'none';
    };
    function renderLines() {
      wrap.querySelector('#mo-lines').innerHTML = draftLines.length ? draftLines.map((l, idx) => `
        <div class="cart-row"><div>${esc(l.name)} x${l.qty}</div><div style="display:flex;align-items:center;gap:8px;">${fmt(l.qty * l.price)} <button type="button" data-mo-rm="${idx}" style="border:none;background:none;color:var(--danger);font-weight:800;cursor:pointer;">✕</button></div></div>
      `).join('') : '<p class="muted">No items added yet.</p>';
      wrap.querySelectorAll('[data-mo-rm]').forEach(b => b.onclick = () => { draftLines.splice(Number(b.dataset.moRm), 1); renderLines(); });
    }
    renderLines();
    wrap.querySelector('#mo-addline').onclick = () => {
      const id = wrap.querySelector('#mo-item').value;
      const qty = Number(wrap.querySelector('#mo-qty').value) || 1;
      const item = items.find(i => i.id === id);
      if (!item) return;
      const existingLine = draftLines.find(l => l.itemId === id);
      if (existingLine) existingLine.qty += qty; else draftLines.push({ itemId: id, name: item.name, qty, price: item.price });
      renderLines();
    };
    wrap.querySelector('#mo-submit').onclick = safe(async () => {
      if (!draftLines.length) { await showAlert('Add at least one item first.'); return; }
      const status = wrap.querySelector('#mo-status').value;
      const paid = status === 'paid';
      const custName = wrap.querySelector('#mo-name').value.trim();
      if (!paid && !custName) { await showAlert('Please enter a customer name for credit orders.'); return; }
      const time = wrap.querySelector('#mo-time').value || nowHHMM();
      await api.recordSale(draftLines.map(l => ({ itemId: l.itemId, name: l.name, qty: l.qty })), paid, custName, time);
      items = await api.getItems();
      close();
      await renderTab();
    });
  }

  // ================= INVENTORY =================
  function itemsTab() {
    const groups = groupByCategory(items);
    const rowsHtml = groups.map(g => `
      <h3 class="section cat-heading">${esc(g.name)}</h3>
      ${g.items.map(it => {
        const cost = itemUnitCost(it);
        const costKnown = it.mode === 'recipe' || (it.pieces_per_box > 0);
        return `<div class="item-list-row">
          <div>
            <div class="nm">${esc(it.name)} <span class="muted">(${it.mode === 'recipe' ? 'Made to order' : 'Stock item'})</span></div>
            <div class="meta">${costKnown ? 'Cost: ' + fmt(cost) + ' · ' : '<span style="color:var(--danger);">Purchase cost not set yet</span> · '}Price: ${fmt(it.price)} (profit ${fmt(it.price - cost)})
            ${it.mode !== 'recipe' ? ' · Stock: ' + it.stock + ' ' + esc(it.unit_label) : ''}</div>
          </div>
          <div style="display:flex;gap:6px;">
            ${it.mode !== 'recipe' ? `<button class="ghost small" data-restock="${it.id}">+ Restock</button>` : ''}
            <button class="ghost small" data-editi="${it.id}">Edit</button>
            <button class="warn small" data-deli="${it.id}">Delete</button>
          </div>
        </div>`;
      }).join('')}
    `).join('');
    const onboarding = items.length === 0 ? `
      <div class="card" style="border-color:var(--accent);">
        <h3 class="section" style="color:var(--accent);">Getting Started</h3>
        <p>Start by adding what's <b>already in your canteen right now</b> — even if it's just a
        couple of packets left. Just enter the current quantity in "Stock" — you can skip the purchase
        price for now and fill it in later. Sells in two ways, like single cigarettes and full packs?
        Add each as its own item (e.g. "Cigarette (Piece)" and "Cigarette (Pack)").</p>
      </div>` : '';
    return `
      <div class="pagehead"><div><h2>Inventory</h2><p>Manage what you sell</p></div>
        <div style="display:flex;gap:8px;">
          <button class="ghost" id="btnManageCats">🏷️ Categories</button>
          <button class="primary" id="btnAddItem">+ Add Item</button>
        </div>
      </div>
      ${onboarding}
      <div class="card">${items.length ? rowsHtml : `<div class="empty">No items added yet.</div>`}</div>
    `;
  }

  function manageCategoriesModal() {
    if (anyModalOpen()) return;
    const cats = [...new Set(items.filter(i => i.mode !== 'recipe').map(i => (i.category || '').trim()).filter(Boolean))].sort();
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    function rowsHtml() {
      return cats.length ? cats.map(c => {
        const count = items.filter(i => (i.category || '').trim() === c).length;
        return `<div class="cart-row"><div>${esc(c)} <span class="muted">(${count})</span></div>
          <div style="display:flex;gap:6px;">
            <button type="button" class="ghost small" data-rn="${esc(c)}">✏️ Rename</button>
            <button type="button" class="warn small" data-dc="${esc(c)}">🗑️</button>
          </div></div>`;
      }).join('') : '<p class="muted">No categories yet — set one when adding/editing an item.</p>';
    }
    wrap.innerHTML = `
      <div class="modal">
        <button class="close-x">&times;</button>
        <h2>🏷️ Manage Categories</h2>
        <p class="muted">Rename a category to relabel every item in it, or remove it (items go back to "Other").</p>
        <div id="cat-list">${rowsHtml()}</div>
        <div class="cart-actions"><button class="ghost" id="cat-close">Close</button></div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.close-x').onclick = close;
    wrap.querySelector('#cat-close').onclick = close;
    function wireRows() {
      wrap.querySelectorAll('[data-rn]').forEach(b => b.onclick = safe(async () => {
        const oldName = b.dataset.rn;
        const newName = prompt('New name for "' + oldName + '":', oldName);
        if (!newName || !newName.trim() || newName.trim() === oldName) return;
        await api.renameCategory(oldName, newName.trim());
        items = await api.getItems();
        close();
        await renderTab();
      }));
      wrap.querySelectorAll('[data-dc]').forEach(b => b.onclick = safe(async () => {
        const name = b.dataset.dc;
        if (!(await showConfirm('Remove category "' + name + '"? Items will move to "Other".'))) return;
        await api.renameCategory(name, '');
        items = await api.getItems();
        close();
        await renderTab();
      }));
    }
    wireRows();
  }

  function itemFormModal(existing) {
    if (anyModalOpen()) return;
    const isEdit = !!existing;
    const it = existing ? JSON.parse(JSON.stringify(existing)) : {
      mode: 'stock', category: '', unit_label: '', price: '', box_cost: '', pieces_per_box: '', stock: '', ingredients: [{ name: '', cost: '' }]
    };
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.innerHTML = `
      <div class="modal">
        <button class="close-x">&times;</button>
        <h2>${isEdit ? 'Edit Item' : 'Add Item'}</h2>
        <div class="toggle-row">
          <button type="button" data-mode="stock" class="${it.mode !== 'recipe' ? 'active' : ''}">I buy &amp; sell this</button>
          <button type="button" data-mode="recipe" class="${it.mode === 'recipe' ? 'active' : ''}">I make this to order</button>
        </div>
        <div class="field"><label>Item name</label><input id="f-name" value="${esc(it.name || '')}" placeholder="e.g. Super Biscuit"></div>
        <div id="mode-fields"></div>
        <div class="cart-actions">
          <button class="primary" id="f-save">Save Item</button>
          <button class="ghost" id="f-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    function closeModal() { wrap.remove(); }

    let mode = it.mode === 'recipe' ? 'recipe' : 'stock';
    let ingredients = (it.ingredients && it.ingredients.length) ? it.ingredients : [{ name: '', cost: '' }];
    let showPurchase = it.mode !== 'recipe' && (it.pieces_per_box > 0 || it.box_cost > 0);

    // Reads whatever is currently in the stock-mode fields back into `it`, so
    // that expanding a section (e.g. "Add purchase cost") never wipes out
    // what was already typed elsewhere in the form.
    function captureStockFields() {
      const g = sel => wrap.querySelector(sel);
      if (g('#f-category')) it.category = g('#f-category').value;
      if (g('#f-unitlabel')) it.unit_label = g('#f-unitlabel').value;
      if (g('#f-price')) it.price = g('#f-price').value;
      if (g('#f-stock')) it.stock = g('#f-stock').value;
      if (g('#f-boxcost')) it.box_cost = g('#f-boxcost').value;
      if (g('#f-pcs')) it.pieces_per_box = g('#f-pcs').value;
    }

    function renderModeFields() {
      const box = wrap.querySelector('#mode-fields');
      if (mode === 'stock') {
        box.innerHTML = `
          <div class="row2">
            <div class="field"><label>Category</label><input id="f-category" list="dl-categories" value="${esc(it.category || '')}" placeholder="e.g. Packs, Bottles"></div>
            ${nameDatalist(categorySuggestions(), 'dl-categories')}
            <div class="field"><label>Sold as (unit label)</label><input id="f-unitlabel" value="${esc(it.unit_label || '')}" placeholder="e.g. packet, piece, bottle"></div>
          </div>
          <div class="row2">
            <div class="field"><label>Selling price</label><input id="f-price" type="number" value="${it.price || ''}" placeholder="20"></div>
            <div class="field"><label>Current stock</label><input id="f-stock" type="number" value="${it.stock !== undefined ? it.stock : ''}" placeholder="e.g. 2"></div>
          </div>

          ${showPurchase ? '' : '<div id="link-purchase" class="expand-link">+ Add purchase cost (for profit tracking)</div>'}
          <div id="wrap-purchase" style="${showPurchase ? '' : 'display:none;'}">
            <h3 class="section">Purchase Cost</h3>
            <div class="row2">
              <div class="field"><label>Carton/box purchase price</label><input id="f-boxcost" type="number" value="${it.box_cost || ''}" placeholder="4000"></div>
              <div class="field"><label>Units per carton</label><input id="f-pcs" type="number" value="${it.pieces_per_box || ''}" placeholder="200"></div>
            </div>
          </div>`;
        const purchaseLink = wrap.querySelector('#link-purchase');
        if (purchaseLink) purchaseLink.onclick = () => { captureStockFields(); showPurchase = true; renderModeFields(); };
      } else {
        box.innerHTML = `<h3 class="section">Ingredients (cost of one serving)</h3><div id="ing-list"></div>
          <button type="button" class="ghost small" id="ing-add">+ Add Ingredient</button>
          <h3 class="section">Selling Price (per serving)</h3>
          <div class="field"><input id="f-price" type="number" value="${it.price || ''}" placeholder="200"></div>`;
        renderIngList();
        wrap.querySelector('#ing-add').onclick = () => { ingredients.push({ name: '', cost: '' }); renderIngList(); };
      }
    }
    // Ingredient values are read directly from the DOM on Save — the list is
    // only re-rendered when a row is added/removed, so typing never loses focus.
    function renderIngList() {
      const list = wrap.querySelector('#ing-list');
      if (!list) return;
      list.innerHTML = ingredients.map((ing, idx) => `
        <div class="ingredient-row" data-row="${idx}">
          <input data-ing-name="${idx}" placeholder="e.g. Milk, 1 glass" value="${esc(ing.name)}">
          <input data-ing-cost="${idx}" type="number" placeholder="Rs" value="${ing.cost}">
          <button type="button" data-ing-rm="${idx}" class="ghost small">✕</button>
        </div>`).join('');
      list.querySelectorAll('[data-ing-rm]').forEach(el => el.onclick = () => {
        list.querySelectorAll('[data-ing-name]').forEach(x => { ingredients[x.dataset.ingName].name = x.value; });
        list.querySelectorAll('[data-ing-cost]').forEach(x => { ingredients[x.dataset.ingCost].cost = x.value; });
        ingredients.splice(Number(el.dataset.ingRm), 1);
        renderIngList();
      });
    }
    wrap.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
      mode = b.dataset.mode;
      wrap.querySelectorAll('[data-mode]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      renderModeFields();
    });
    renderModeFields();

    wrap.querySelector('.close-x').onclick = closeModal;
    wrap.querySelector('#f-cancel').onclick = closeModal;
    wrap.querySelector('#f-save').onclick = safe(async () => {
      const name = wrap.querySelector('#f-name').value.trim();
      if (!name) { await showAlert('Please enter an item name.'); return; }
      const newItem = { id: existing ? existing.id : undefined, name, mode };
      if (mode === 'stock') {
        newItem.category = wrap.querySelector('#f-category').value.trim();
        const unitLabel = wrap.querySelector('#f-unitlabel').value.trim() || 'pcs';
        newItem.unit_label = unitLabel;
        newItem.price = Number(wrap.querySelector('#f-price').value) || 0;
        const stockVal = wrap.querySelector('#f-stock').value;
        newItem.stock = stockVal === '' ? (Number(it.stock) || 0) : Number(stockVal);
        const boxCostEl = wrap.querySelector('#f-boxcost');
        newItem.box_cost = (showPurchase && boxCostEl) ? Number(boxCostEl.value) || 0 : 0;
        newItem.pieces_per_box = (showPurchase && wrap.querySelector('#f-pcs')) ? Number(wrap.querySelector('#f-pcs').value) || 0 : 0;
        newItem.ingredients = [];
      } else {
        wrap.querySelectorAll('[data-ing-name]').forEach(el => { ingredients[el.dataset.ingName].name = el.value; });
        wrap.querySelectorAll('[data-ing-cost]').forEach(el => { ingredients[el.dataset.ingCost].cost = el.value; });
        newItem.ingredients = ingredients.filter(i => i.name.trim() !== '').map(i => ({ name: i.name, cost: Number(i.cost) || 0 }));
        newItem.price = Number(wrap.querySelector('#f-price').value) || 0;
        newItem.category = 'Homemade';
        newItem.unit_label = 'serving';
        newItem.box_cost = 0; newItem.pieces_per_box = 0; newItem.stock = 0;
      }
      await api.saveItem(newItem);
      items = await api.getItems();
      closeModal();
      await renderTab();
    });
  }

  function wireItems() {
    const addBtn = document.getElementById('btnAddItem');
    if (addBtn) addBtn.onclick = () => itemFormModal(null);
    const catBtn = document.getElementById('btnManageCats');
    if (catBtn) catBtn.onclick = () => manageCategoriesModal();
    document.querySelectorAll('[data-editi]').forEach(el => el.onclick = () => {
      itemFormModal(items.find(i => i.id === el.dataset.editi));
    });
    document.querySelectorAll('[data-deli]').forEach(el => el.onclick = safe(async () => {
      if (!(await showConfirm('Delete this item?'))) return;
      await api.deleteItem(el.dataset.deli);
      items = await api.getItems();
      await renderTab();
    }));
    document.querySelectorAll('[data-restock]').forEach(el => el.onclick = () => {
      restockModal(items.find(i => i.id === el.dataset.restock));
    });
  }

  function restockModal(item) {
    if (anyModalOpen() || !item) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.innerHTML = `
      <div class="modal small-modal">
        <button class="close-x">&times;</button>
        <h2>Restock — ${esc(item.name)}</h2>
        <p class="muted">Current stock: ${item.stock} ${esc(item.unit_label)}</p>
        <div class="field"><label>Units to add</label><input id="rs-qty" type="number" placeholder="e.g. 20"></div>
        <div class="cart-actions">
          <button class="primary" id="rs-save">Add to Stock</button>
          <button class="ghost" id="rs-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.close-x').onclick = close;
    wrap.querySelector('#rs-cancel').onclick = close;
    wrap.querySelector('#rs-save').onclick = safe(async () => {
      const n = Number(wrap.querySelector('#rs-qty').value);
      if (!n || n <= 0) { await showAlert('Please enter a valid quantity.'); return; }
      await api.restock(item.id, n);
      items = await api.getItems();
      close();
      await renderTab();
    });
    setTimeout(() => wrap.querySelector('#rs-qty').focus(), 20);
  }

  // ================= CREDIT =================
  async function creditTab() {
    currentDebts = await api.getDebts();
    const rows = currentDebts.map(d => `
      <tr class="${d.balance >= 500 ? 'debt-high' : ''}">
        <td>${esc(d.name)}</td>
        <td>${fmt(d.balance)}</td>
        <td>
          <button class="ghost small" data-pay="${d.id}">💰 Pay</button>
          <button class="ghost small" data-adddebt="${d.id}">➕ Credit</button>
          <button class="ghost small" data-hist="${d.id}">🕓 History</button>
          <button class="warn small" data-delp="${d.id}">🗑️</button>
        </td>
      </tr>`).join('');
    return `
      <div class="pagehead"><div><h2>Credit</h2><p>Balances of Rs 500+ are highlighted</p></div>
        <button class="primary" id="btnAddPerson">+ Add Person</button></div>
      <div class="card">
        ${currentDebts.length ? `<table><tr><th>Name</th><th>Balance</th><th>Action</th></tr>${rows}</table>` : `<div class="empty">No credit records yet.</div>`}
      </div>
    `;
  }
  function wireCredit() {
    const addP = document.getElementById('btnAddPerson');
    if (addP) addP.onclick = () => addPersonModal();
    document.querySelectorAll('[data-pay]').forEach(el => el.onclick = () => {
      paymentModal(currentDebts.find(d => d.id === el.dataset.pay));
    });
    document.querySelectorAll('[data-adddebt]').forEach(el => el.onclick = () => {
      addCreditModal(currentDebts.find(d => d.id === el.dataset.adddebt));
    });
    document.querySelectorAll('[data-delp]').forEach(el => el.onclick = safe(async () => {
      if (!(await showConfirm('Delete this person? Their credit history will be removed.'))) return;
      await api.deleteDebtPerson(el.dataset.delp);
      await renderTab();
    }));
    document.querySelectorAll('[data-hist]').forEach(el => el.onclick = safe(async () => {
      await historyModal(currentDebts.find(d => d.id === el.dataset.hist));
    }));
  }

  async function historyModal(debt) {
    if (anyModalOpen() || !debt) return;
    const hist = await api.getDebtHistory(debt.id);
    const rows = hist.length ? hist.map(h => {
      const isCredit = h.amount > 0;
      const label = h.type === 'payment' ? 'Payment' : h.type === 'reversal' ? 'Reversed' : 'Order';
      return `<div class="cart-row" style="align-items:flex-start;">
        <div>
          <div>${esc(label)}${h.note ? ' — <span class="muted">' + esc(h.note) + '</span>' : ''}</div>
          <div class="muted" style="font-size:11px;">${esc(h.date)}${h.time ? ' · ' + esc(h.time) : ''}</div>
        </div>
        <div style="font-weight:800;color:${isCredit ? 'var(--danger)' : 'var(--success)'};white-space:nowrap;">${isCredit ? '+' : ''}${fmt(h.amount)}</div>
      </div>`;
    }).join('') : '<p class="muted">No history yet.</p>';
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.innerHTML = `
      <div class="modal">
        <button class="close-x">&times;</button>
        <h2>🕓 History — ${esc(debt.name)}</h2>
        <p class="muted">Current balance: <b>${fmt(debt.balance)}</b></p>
        <div>${rows}</div>
        <div class="cart-actions"><button class="ghost" id="hist-close">Close</button></div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.close-x').onclick = close;
    wrap.querySelector('#hist-close').onclick = close;
  }

  function addPersonModal() {
    if (anyModalOpen()) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.innerHTML = `
      <div class="modal small-modal">
        <button class="close-x">&times;</button>
        <h2>Add Person</h2>
        <div class="field"><label>Name</label><input id="ap-name" list="dl-addperson" placeholder="Name"></div>
        ${nameDatalist(currentDebts.map(d => d.name), 'dl-addperson')}
        <div class="cart-actions">
          <button class="primary" id="ap-save">Add</button>
          <button class="ghost" id="ap-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.close-x').onclick = close;
    wrap.querySelector('#ap-cancel').onclick = close;
    wrap.querySelector('#ap-save').onclick = safe(async () => {
      const name = wrap.querySelector('#ap-name').value.trim();
      if (!name) { await showAlert('Please enter a name.'); return; }
      await api.addDebtPerson(name);
      close();
      await renderTab();
    });
    setTimeout(() => wrap.querySelector('#ap-name').focus(), 20);
  }

  function paymentModal(debt) {
    if (anyModalOpen() || !debt) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.innerHTML = `
      <div class="modal small-modal">
        <button class="close-x">&times;</button>
        <h2>Record Payment</h2>
        <p class="muted">${esc(debt.name)} — current balance: <b>${fmt(debt.balance)}</b></p>
        <div class="field"><label>Amount received</label><input id="pay-amount" type="number" placeholder="e.g. 500"></div>
        <div class="cart-actions">
          <button class="primary" id="pay-partial">Record This Amount</button>
        </div>
        <div class="cart-actions">
          <button class="ghost" id="pay-full">Mark Fully Paid (${fmt(debt.balance)})</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.close-x').onclick = close;
    wrap.querySelector('#pay-full').onclick = safe(async () => {
      await api.payDebt(debt.id, debt.balance);
      close(); await renderTab();
    });
    wrap.querySelector('#pay-partial').onclick = safe(async () => {
      const amt = Number(wrap.querySelector('#pay-amount').value);
      if (!amt || amt <= 0) { await showAlert('Please enter a valid amount.'); return; }
      await api.payDebt(debt.id, amt);
      close(); await renderTab();
    });
    setTimeout(() => wrap.querySelector('#pay-amount').focus(), 20);
  }

  function addCreditModal(debt) {
    if (anyModalOpen() || !debt) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.innerHTML = `
      <div class="modal small-modal">
        <button class="close-x">&times;</button>
        <h2>Add Credit</h2>
        <p class="muted">${esc(debt.name)} — current balance: <b>${fmt(debt.balance)}</b></p>
        <div class="field"><label>Amount to add</label><input id="ac-amount" type="number" placeholder="e.g. 100"></div>
        <div class="cart-actions">
          <button class="primary" id="ac-save">Add</button>
          <button class="ghost" id="ac-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.close-x').onclick = close;
    wrap.querySelector('#ac-cancel').onclick = close;
    wrap.querySelector('#ac-save').onclick = safe(async () => {
      const amt = Number(wrap.querySelector('#ac-amount').value);
      if (!amt || amt <= 0) { await showAlert('Please enter a valid amount.'); return; }
      await api.addDebtManual(debt.id, amt);
      close(); await renderTab();
    });
    setTimeout(() => wrap.querySelector('#ac-amount').focus(), 20);
  }

  // ================= EXPENSES =================
  async function expensesTab() {
    const exp = await api.getExpensesForDate(today);
    const rows = exp.map(e => `<tr><td>${e.time || ''}</td><td>${esc(e.name)}</td><td>${fmt(e.amount)}</td>
      <td><button class="warn small" data-dele="${e.id}">✕</button></td></tr>`).join('');
    const total = exp.reduce((s, e) => s + Number(e.amount || 0), 0);
    return `
      <div class="pagehead"><div><h2>Expenses</h2><p>Log any cash taken out of the counter</p></div></div>
      <div class="card">
        <div class="row2">
          <div class="field"><label>What was it for</label><input id="e-name" placeholder="e.g. Petrol"></div>
          <div class="field"><label>Amount</label><input id="e-amount" type="number" placeholder="100"></div>
        </div>
        <button class="primary" id="btnAddExpense">+ Add Expense</button>
      </div>
      <div class="card">
        <h3 class="section">Today's Expenses</h3>
        ${exp.length ? `<table><tr><th>Time</th><th>Item</th><th>Amount</th><th></th></tr>${rows}</table>
        <div class="cart-total" style="margin-top:12px;"><span>Total</span><span>${fmt(total)}</span></div>` : `<div class="empty">No expenses logged today.</div>`}
      </div>
    `;
  }
  function wireExpenses() {
    const btn = document.getElementById('btnAddExpense');
    if (btn) btn.onclick = safe(async () => {
      const name = document.getElementById('e-name').value.trim();
      const amount = Number(document.getElementById('e-amount').value);
      if (!name || !amount) { await showAlert('Please fill in both fields.'); return; }
      await api.addExpense(name, amount);
      await renderTab();
    });
    document.querySelectorAll('[data-dele]').forEach(el => el.onclick = safe(async () => {
      await api.deleteExpense(el.dataset.dele);
      await renderTab();
    }));
  }

  // ================= REPORTS =================
  let chartRefs = {};
  function dateNDaysAgo(n) { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
  async function realProfitLine(grossProfit) {
    const rent = Number(await api.getSetting('shopRent', 0));
    if (!rent) return '';
    const d = new Date(today);
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const dailyRent = rent / daysInMonth;
    const realProfit = grossProfit - dailyRent;
    return `<div style="color:var(--text-soft);font-size:11px;font-weight:600;margin-bottom:2px;">Asal Profit: ${fmt(realProfit)}</div>`;
  }

  async function reportsTab() {
    const sToday = await api.daySummary(today);
    const sYest = await api.daySummary(dateNDaysAgo(1));
    const change = sYest.totalSales > 0 ? (((sToday.totalSales - sYest.totalSales) / sYest.totalSales) * 100).toFixed(0) : null;
    const bestItem = Object.entries(sToday.byItem).sort((a, b) => b[1].qty - a[1].qty)[0];
    const monthKey = today.slice(0, 7);
    const monthProfit = await api.getMonthProfit(monthKey);
    const goal = Number(await api.getSetting('monthlyGoal', 20000));
    const pct = goal > 0 ? Math.min(100, Math.round(monthProfit / goal * 100)) : 0;
    const realProfitHtml = await realProfitLine(sToday.totalProfit);

    return `
      <div class="pagehead"><div><h2>Reports</h2><p>Daily, weekly and monthly performance</p></div></div>
      <div class="grid-stats">
        <div class="stat good"><div class="label">Today's Sales</div><div class="value">${fmt(sToday.totalSales)}</div>
          <div class="sub">${change === null ? '' : (change >= 0 ? '▲ ' + change + '% vs yesterday' : '▼ ' + Math.abs(change) + '% vs yesterday')}</div></div>
        <div class="stat good"><div class="label">Today's Profit</div>${realProfitHtml}<div class="value">${fmt(sToday.totalProfit)}</div></div>
        <div class="stat"><div class="label">Best Seller Today</div><div class="value" style="font-size:16px;">${bestItem ? esc(bestItem[0]) + ' (' + bestItem[1].qty + ')' : '—'}</div></div>
        <div class="stat"><div class="label">This Month's Profit</div><div class="value">${fmt(monthProfit)}</div></div>
      </div>
      <div class="card">
        <h3 class="section">Monthly Savings Goal (${fmt(goal)})</h3>
        <div class="savings-bar"><div class="savings-bar-fill" style="width:${pct}%;"></div></div>
        <p class="muted">${fmt(monthProfit)} saved so far this month (${pct}%). ${monthProfit >= goal ? 'Goal reached! 🎉' : fmt(goal - monthProfit) + ' to go.'}</p>
      </div>
      <div class="card"><h3 class="section">Last 7 Days — Sales &amp; Profit</h3><div class="charts-wrap"><canvas id="chartWeek" height="220"></canvas></div></div>
      <div class="card"><h3 class="section">This Month — Daily Sales</h3><div class="charts-wrap"><canvas id="chartMonth" height="220"></canvas></div></div>
      <div class="card"><h3 class="section">Today — Sales by Hour</h3><div class="charts-wrap"><canvas id="chartHour" height="220"></canvas></div></div>
      <div class="card">
        <h3 class="section">Today's Item Breakdown</h3>
        ${Object.keys(sToday.byItem).length ? `<table><tr><th>Item</th><th>Qty</th><th>Total</th></tr>
          ${Object.entries(sToday.byItem).sort((a, b) => b[1].total - a[1].total).map(([n, v]) => `<tr><td>${esc(n)}</td><td>${v.qty}</td><td>${fmt(v.total)}</td></tr>`).join('')}
          </table>` : `<div class="empty">No sales yet today.</div>`}
      </div>
    `;
  }

  async function drawCharts() {
    if (typeof Chart === 'undefined') return;
    Object.values(chartRefs).forEach(c => c && c.destroy());
    const isDark = document.documentElement.dataset.theme === 'dark';
    const gridColor = isDark ? 'rgba(244,234,217,.08)' : 'rgba(43,36,27,.08)';
    const textColor = isDark ? '#b3a284' : '#8a7f6b';
    Chart.defaults.color = textColor;
    Chart.defaults.borderColor = gridColor;

    const start = dateNDaysAgo(6);
    const range = await api.getRangeSummary(start, today);
    const labels = range.map(r => r.date.slice(5));
    const sales = range.map(r => r.totalSales);
    const profit = range.map(r => r.totalProfit);
    const ctxW = document.getElementById('chartWeek');
    if (ctxW) chartRefs.week = new Chart(ctxW, {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Sales', data: sales, backgroundColor: '#3f7bbf', borderRadius: 4 },
        { label: 'Profit', data: profit, backgroundColor: isDark ? '#57b783' : '#2f6f4f', borderRadius: 4 }
      ] },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });

    const monthStart = today.slice(0, 8) + '01';
    const rangeMonth = await api.getRangeSummary(monthStart, today);
    const mLabels = rangeMonth.map(r => String(Number(r.date.slice(8, 10))));
    const mSales = rangeMonth.map(r => r.totalSales);
    const ctxM = document.getElementById('chartMonth');
    if (ctxM) chartRefs.month = new Chart(ctxM, {
      type: 'line',
      data: { labels: mLabels, datasets: [{ label: 'Daily Sales', data: mSales, borderColor: '#e0a83d', backgroundColor: 'rgba(224,168,61,.22)', fill: true, tension: .25 }] },
      options: { responsive: true, plugins: { legend: { display: false } } }
    });

    const salesToday = await api.getSalesForDate(today);
    const hourly = {};
    salesToday.forEach(s => { const h = (s.time || '00:00').slice(0, 2) + ':00'; hourly[h] = (hourly[h] || 0) + s.total; });
    const hLabels = Object.keys(hourly).sort();
    const hVals = hLabels.map(h => hourly[h]);
    const ctxH = document.getElementById('chartHour');
    if (ctxH) chartRefs.hour = new Chart(ctxH, {
      type: 'bar',
      data: { labels: hLabels, datasets: [{ label: 'Sales', data: hVals, backgroundColor: '#c0392b', borderRadius: 4 }] },
      options: { responsive: true, plugins: { legend: { display: false } } }
    });
  }

  // ================= SETTINGS =================
  async function settingsTab() {
    const goal = await api.getSetting('monthlyGoal', 20000);
    const rent = await api.getSetting('shopRent', 0);
    const dbPath = await api.getDbPath();
    return `
      <div class="pagehead"><div><h2>Settings</h2><p>App preferences and data location</p></div></div>
      <div class="card">
        <h3 class="section">Monthly Goal</h3>
        <div class="field"><label>Monthly savings / rent goal</label><input id="s-goal" type="number" value="${goal}"></div>
        <h3 class="section" style="margin-top:16px;">Shop Rent (for Real Profit)</h3>
        <p class="muted">Monthly rent — your day's Real Profit is Today's Profit minus this rent's daily share.</p>
        <div class="field"><label>Monthly shop rent</label><input id="s-rent" type="number" value="${rent}" placeholder="e.g. 15000"></div>
        <button class="primary" id="s-save">💾 Save</button>
      </div>
      <div class="card">
        <h3 class="section">📁 Data File</h3>
        <p class="muted">All your data is stored on this device, at this real file (you can browse/copy it directly over USB or a file manager app):</p>
        <p style="font-family:Consolas,Menlo,monospace;font-size:12px;background:var(--card-alt);padding:10px;border-radius:8px;word-break:break-all;">${esc(dbPath)}</p>
        <p class="muted">Keep a backup of this file so your data is never lost.</p>
      </div>
      <div class="card">
        <h3 class="section">🔄 Backup</h3>
        <p class="muted">Import your existing chaico_data.db backup (from the desktop app or an older phone backup), or export the current data as a .db file to keep safe. Tip: since the file above is a real file, you can also just copy your old chaico_data.db into that exact folder with a file manager or USB cable — no import needed.</p>
        <div class="cart-actions">
          <button class="primary" id="s-export">⬇ Export Backup (.db)</button>
          <button class="ghost" id="s-import">⬆ Import Backup (.db)</button>
        </div>
        <input type="file" id="s-import-file" accept=".db,.sqlite,.sqlite3" style="display:none;">
      </div>
    `;
  }
  function wireSettings() {
    const btn = document.getElementById('s-save');
    if (btn) btn.onclick = safe(async () => {
      await api.setSetting('monthlyGoal', Number(document.getElementById('s-goal').value) || 0);
      await api.setSetting('shopRent', Number(document.getElementById('s-rent').value) || 0);
      await showAlert('Saved.');
    });
    const exportBtn = document.getElementById('s-export');
    if (exportBtn) exportBtn.onclick = safe(async () => {
      const bytes = await api.exportDbBytes();
      const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'chaico_data_backup_' + today + '.db';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
    const importBtn = document.getElementById('s-import');
    const importFile = document.getElementById('s-import-file');
    if (importBtn && importFile) {
      importBtn.onclick = () => importFile.click();
      importFile.onchange = safe(async () => {
        const file = importFile.files[0];
        if (!file) return;
        if (!(await showConfirm('This will replace all data currently on this phone with the contents of "' + file.name + '". Continue?'))) { importFile.value = ''; return; }
        const buf = await file.arrayBuffer();
        await api.importDbBytes(new Uint8Array(buf));
        items = await api.getItems();
        await showAlert('Backup imported successfully.');
        await renderTab();
      });
    }
  }

  boot().catch(async err => {
    console.error('Boot failed:', err);
    await showAlert('Chaico failed to start: ' + (err && err.message ? err.message : err));
  });
})();
