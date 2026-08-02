/* Quotes and invoices.
 *
 * A job is one record that moves along: quoted, then invoiced when the work is
 * done. It keeps the reference it held as a quote, so an invoice still shows
 * where it came from. Work that has been accepted but not yet invoiced is a
 * quote marked Accepted, not a separate kind of document.
 *
 * The arithmetic is carried over unchanged from the standalone quoting app it
 * replaces. It has been in use and giving the right answers, so it is copied
 * rather than rewritten.
 */

(function () {
  'use strict';

  var api = window.Admin.api;
  var say = window.Admin.say;
  var esc = window.Admin.esc;
  var ask = window.Admin.ask;
  var confirmAsk = window.Admin.confirm;
  var promptAsk = window.Admin.prompt;

  var TYPES = {
    quote: {
      noun: 'quote',
      heading: 'QUOTATION',
      prefix: 'Q',
      statuses: [
        { value: 'draft', label: 'Draft' },
        { value: 'sent', label: 'Sent' },
        { value: 'accepted', label: 'Accepted' },
        { value: 'declined', label: 'Declined' },
      ],
    },
    invoice: {
      noun: 'invoice',
      heading: 'INVOICE',
      prefix: 'INV',
      statuses: [
        { value: 'draft', label: 'Draft' },
        { value: 'sent', label: 'Sent' },
        { value: 'paid', label: 'Paid' },
      ],
    },
  };

  var state = { documents: [], loaded: false, type: 'all', status: 'all' };
  var current = null;        // the job open in the builder
  var savedStatus = null;    // the status it had when it was opened or last saved
  var dirty = false;
  // Which material is unfolded on a phone, as "taskIndex:materialIndex".
  // Only ever one, so adding another folds the last one away.
  var openMaterial = null;

  var listView = document.getElementById('doc-list-view');
  var builderView = document.getElementById('doc-builder-view');

  /* ----------------------------------------------------------- arithmetic */

  function money(n) {
    return '£' + (isFinite(n) ? n : 0).toLocaleString('en-GB', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  function matCost(m) { return (+m.qty || 0) * (+m.cost || 0); }

  /**
   * What the customer pays for a material line.
   *
   * Normally the cost plus the markup. But a price typed in by hand wins:
   * sometimes you know what you are charging for something without knowing,
   * or caring, what it cost you.
   */
  function matCharge(m) {
    if (+m.price > 0) return (+m.qty || 0) * (+m.price || 0);
    return matCost(m) * (1 + (+m.markup || 0) / 100);
  }
  function taskLabour(t) {
    if (t.labourType === 'fixed') return +t.fixed || 0;
    return (+t.rate || 0) * (+t.qty || 0);
  }
  function taskMatsCost(t) {
    return t.materials.reduce(function (s, m) { return s + matCost(m); }, 0);
  }
  function taskMatsCharge(t) {
    return t.materials.reduce(function (s, m) { return s + matCharge(m); }, 0);
  }
  function taskTotal(t) { return taskLabour(t) + taskMatsCharge(t); }

  function calc(doc) {
    var tasks = doc.tasks || [];
    var matsCost = tasks.reduce(function (s, t) { return s + taskMatsCost(t); }, 0);
    var matsCharge = tasks.reduce(function (s, t) { return s + taskMatsCharge(t); }, 0);
    var labour = tasks.reduce(function (s, t) { return s + taskLabour(t); }, 0);
    var subtotal = matsCharge + labour;
    var vat = subtotal * ((+doc.vat_rate || 0) / 100);
    return {
      matsCost: matsCost, matsCharge: matsCharge, matsProfit: matsCharge - matsCost,
      labour: labour, subtotal: subtotal, vat: vat, total: subtotal + vat,
    };
  }

  /* --------------------------------------------------------------- helpers */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  function setting(key, fallback) {
    var all = window.Admin.settings() || {};
    var value = all[key];
    return value === undefined || value === '' ? fallback : value;
  }

  function num(key, fallback) {
    var n = Number(setting(key, fallback));
    return isFinite(n) ? n : fallback;
  }

  function statusLabel(doc) {
    if (isOverdue(doc)) return 'Overdue';
    var found = TYPES[doc.doc_type].statuses.filter(function (s) {
      return s.value === doc.status;
    })[0];
    return found ? found.label : doc.status;
  }

  // Not stored: an invoice is overdue when it is past its due date and has not
  // been paid. Working it out here means it is never stale.
  function isOverdue(doc) {
    return doc.doc_type === 'invoice' && doc.status !== 'paid' &&
      !!doc.due_date && doc.due_date < today();
  }

  /**
   * The next number in the sequence, offered as a starting point.
   *
   * Only a suggestion: the reference is yours to set, so this works out what
   * comes next from what is already there rather than being authoritative.
   */
  function suggestRef(docType) {
    var prefix = TYPES[docType].prefix + '-' + new Date().getFullYear() + '-';
    var highest = 0;
    state.documents.forEach(function (doc) {
      ['quote_ref', 'invoice_ref'].forEach(function (column) {
        var value = doc[column];
        if (!value || value.indexOf(prefix) !== 0) return;
        var tail = Number(value.slice(prefix.length));
        if (isFinite(tail) && tail > highest) highest = tail;
      });
    });
    return prefix + String(highest + 1).padStart(3, '0');
  }

  function ukDate(iso) {
    if (!iso) return '';
    var parts = String(iso).split('-');
    if (parts.length !== 3) return iso;
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  /* ------------------------------------------------------------- the list */

  function statusFilterButtons() {
    var host = document.getElementById('doc-status-filter');
    var options = [{ value: 'all', label: 'Any status' }];

    if (state.type === 'all') {
      options.push({ value: 'open', label: 'Not finished' });
      options.push({ value: 'overdue', label: 'Overdue' });
    } else {
      TYPES[state.type].statuses.forEach(function (s) { options.push(s); });
      if (state.type === 'invoice') options.push({ value: 'overdue', label: 'Overdue' });
    }

    host.innerHTML = options.map(function (o) {
      return '<button class="admin-btn-small" data-docstatus="' + esc(o.value) + '"' +
        (state.status === o.value ? ' aria-pressed="true"' : '') + '>' + esc(o.label) + '</button>';
    }).join('');
  }

  function matches(doc) {
    if (state.type !== 'all' && doc.doc_type !== state.type) return false;
    if (state.status === 'all') return true;
    if (state.status === 'overdue') return isOverdue(doc);
    if (state.status === 'open') {
      return ['declined', 'paid'].indexOf(doc.status) === -1;
    }
    return doc.status === state.status;
  }

  function documentRow(doc) {
    var totals = calc(doc);
    var type = TYPES[doc.doc_type];

    var previous = [];
    if (doc.doc_type !== 'quote' && doc.quote_ref) previous.push('quote ' + doc.quote_ref);

    var badgeClass = isOverdue(doc)
      ? ' admin-item__badge--hidden'
      : ['accepted', 'paid'].indexOf(doc.status) >= 0
        ? ' admin-item__badge--featured'
        : '';

    var meta = [
      doc.customer_name || 'No customer',
      ukDate(doc.issue_date),
      (doc.tasks || []).length + ((doc.tasks || []).length === 1 ? ' task' : ' tasks'),
      money(totals.total),
    ].join(' · ');

    var convert = doc.doc_type === 'quote'
      ? '<button type="button" class="admin-btn-small" data-convert="invoice" ' +
        'title="Turn this quote into an invoice">Invoice</button>'
      : '';

    return '' +
      '<div class="admin-item admin-doc" data-id="' + doc.id + '">' +
        '<span class="admin-doc__type admin-doc__type--' + esc(doc.doc_type) + '">' +
          esc(type.noun) + '</span>' +
        '<div class="admin-item__body">' +
          '<p class="admin-item__title">' + esc(doc.ref) + ' ' + esc(doc.title || 'Untitled job') +
            '<span class="admin-item__badge' + badgeClass + '">' + esc(statusLabel(doc)) + '</span>' +
          '</p>' +
          '<p class="admin-item__meta">' + esc(meta) +
            (previous.length ? ' · from ' + esc(previous.join(', ')) : '') +
          '</p>' +
        '</div>' +
        '<div class="admin-item__actions">' +
          '<button type="button" class="admin-btn-small" data-doc-action="open">Open</button>' +
          convert +
          '<button type="button" class="admin-btn-small" data-doc-action="duplicate">Duplicate</button>' +
          '<button type="button" class="admin-btn-small admin-btn-small--danger" data-doc-action="delete">Delete</button>' +
        '</div>' +
      '</div>';
  }

  function renderList() {
    statusFilterButtons();

    document.querySelectorAll('[data-doctype]').forEach(function (b) {
      if (b.getAttribute('data-doctype') === state.type) b.setAttribute('aria-pressed', 'true');
      else b.removeAttribute('aria-pressed');
    });

    var shown = state.documents.filter(matches);
    var host = document.getElementById('list-documents');

    if (!shown.length) {
      host.innerHTML = '<p class="admin-empty">' +
        (state.documents.length
          ? 'Nothing matches those filters.'
          : 'No quotes yet. Start one with the button above.') +
        '</p>';
      return;
    }
    host.innerHTML = shown.map(documentRow).join('');
  }

  function renderDefaults() {
    var form = document.getElementById('doc-defaults-form');
    ['quote_hourly_rate', 'quote_day_rate', 'quote_markup', 'quote_vat'].forEach(function (key) {
      var input = form.elements[key];
      if (input) input.value = setting(key, '');
    });
  }

  /* ---------------------------------------------------------- the builder */

  function blankTask() {
    return {
      id: uid(), name: '', labourType: 'hourly',
      rate: num('quote_hourly_rate', 35), qty: 0, fixed: 0, materials: [],
    };
  }

  function blankMaterial() {
    return { id: uid(), name: '', qty: 1, cost: 0, markup: num('quote_markup', 20), price: 0 };
  }

  function blankDocument(docType) {
    return {
      id: null, doc_type: docType, status: TYPES[docType].statuses[0].value,
      ref: suggestRef(docType), quote_ref: null, order_ref: null, invoice_ref: null,
      issue_date: today(), due_date: null,
      title: '', customer_name: '', customer_phone: '', customer_email: '',
      job_address: '', notes: '', vat_rate: num('quote_vat', 20),
      price_view: 'full', tasks: [],
    };
  }

  function taskHtml(task, i) {
    var labourInputs;
    if (task.labourType === 'fixed') {
      labourInputs =
        '<div class="admin-field"><label>Fixed labour (£)</label>' +
        '<input type="number" step="0.01" min="0" value="' + esc(task.fixed) +
        '" data-task="' + i + '" data-field="fixed"></div>';
    } else {
      var unit = task.labourType === 'day' ? 'Days' : 'Hours';
      labourInputs =
        '<div class="admin-field"><label>Rate (£ per ' +
          (task.labourType === 'day' ? 'day' : 'hour') + ')</label>' +
        '<input type="number" step="0.01" min="0" value="' + esc(task.rate) +
        '" data-task="' + i + '" data-field="rate"></div>' +
        '<div class="admin-field"><label>' + unit + '</label>' +
        '<input type="number" step="0.25" min="0" value="' + esc(task.qty) +
        '" data-task="' + i + '" data-field="qty"></div>';
    }

    var rows = task.materials.map(function (m, mi) {
      // A price typed in by hand takes over from the markup, so the markup box
      // is switched off rather than left there looking as though it still does
      // something.
      var pricedByHand = +m.price > 0;
      return '' +
        // data-label carries the column heading down to phone width, where the
        // row becomes a stack and the heading row is no longer above it.
        //
        // The last cell is the header the stack folds under on a phone. It is
        // last in the markup so the column widths above are not shifted along
        // by one, and CSS puts it back on top where it is used.
        '<tr' + (openMaterial === i + ':' + mi ? ' class="is-open"' : '') + '>' +
          '<td data-label="Material"><input type="text" placeholder="Material" value="' + esc(m.name) +
            '" data-task="' + i + '" data-material="' + mi + '" data-field="name"></td>' +
          '<td data-label="Qty"><input type="number" step="0.01" min="0" value="' + esc(m.qty) +
            '" data-task="' + i + '" data-material="' + mi + '" data-field="qty"></td>' +
          '<td data-label="Unit cost"><span class="admin-money">' +
            '<input type="number" step="0.01" min="0" value="' + esc(m.cost) +
            '" data-task="' + i + '" data-material="' + mi + '" data-field="cost"></span></td>' +
          '<td data-label="Markup %"><input type="number" step="0.5" min="0" value="' + esc(m.markup) +
            '" data-task="' + i + '" data-material="' + mi + '" data-field="markup"' +
            (pricedByHand ? ' disabled title="Not used while a price is set"' : '') + '></td>' +
          '<td data-label="Price each"><span class="admin-money">' +
            '<input type="number" step="0.01" min="0" value="' + esc(m.price || '') +
            '" placeholder="auto" data-task="' + i + '" data-material="' + mi +
            '" data-field="price"></span></td>' +
          '<td data-label="Costs you" class="admin-doc__num">' + money(matCost(m)) + '</td>' +
          '<td data-label="They pay" class="admin-doc__num"><strong>' + money(matCharge(m)) + '</strong></td>' +
          '<td data-label=""><button type="button" class="admin-btn-small admin-btn-small--danger" ' +
            'data-task="' + i + '" data-material="' + mi + '" data-material-action="delete" ' +
            'aria-label="Remove this material">Remove</button></td>' +
          '<td class="admin-task__toggle">' +
            '<button type="button" data-task="' + i + '" data-material="' + mi +
              '" data-material-action="toggle" aria-expanded="' +
              (openMaterial === i + ':' + mi ? 'true' : 'false') + '">' +
              '<span class="admin-task__toggle-name">' +
                esc(m.name || 'New material') + '</span>' +
              '<span class="admin-task__toggle-sum">' + money(matCharge(m)) + '</span>' +
            '</button>' +
          '</td>' +
        '</tr>';
    }).join('');

    return '' +
      '<div class="admin-card admin-task">' +
        '<div class="admin-task__head">' +
          '<div class="admin-field admin-task__name">' +
            '<label>Task ' + (i + 1) + '</label>' +
            '<input type="text" placeholder="e.g. Build the deck frame" value="' + esc(task.name) +
              '" data-task="' + i + '" data-field="name">' +
          '</div>' +
          '<div class="admin-field"><label>Charged as</label>' +
            '<select data-task="' + i + '" data-field="labourType">' +
              '<option value="hourly"' + (task.labourType === 'hourly' ? ' selected' : '') + '>By the hour</option>' +
              '<option value="day"' + (task.labourType === 'day' ? ' selected' : '') + '>By the day</option>' +
              '<option value="fixed"' + (task.labourType === 'fixed' ? ' selected' : '') + '>Fixed price</option>' +
            '</select></div>' +
          labourInputs +
          '<button type="button" class="admin-btn-small admin-btn-small--danger admin-task__delete" ' +
            'data-task="' + i + '" data-task-action="delete">Delete task</button>' +
        '</div>' +

        '<table class="admin-table admin-task__materials">' +
          '<thead><tr>' +
            '<th scope="col">Material</th><th scope="col">Qty</th>' +
            '<th scope="col">Unit cost</th><th scope="col">Markup %</th>' +
            '<th scope="col">Price each</th>' +
            '<th scope="col">Costs you</th><th scope="col">They pay</th><th scope="col"></th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
        (task.materials.length
          ? '<p class="admin-hint">Leave "price each" empty and the charge is worked out from the cost and the markup. Fill it in and it is used instead, which is handy when you know what you are charging but not what it costs you.</p>'
          : '<p class="admin-empty">No materials on this task.</p>') +
        '<div class="admin-doc-actions admin-doc-actions--left">' +
          '<button type="button" class="admin-btn-small" data-task="' + i + '" data-task-action="add-material">Add a material</button>' +
        '</div>' +

        '<div class="admin-task__sub">' +
          '<span>Materials <strong>' + money(taskMatsCharge(task)) + '</strong></span>' +
          '<span>Labour <strong>' + money(taskLabour(task)) + '</strong></span>' +
          '<span>Task total <strong>' + money(taskTotal(task)) + '</strong></span>' +
        '</div>' +
      '</div>';
  }

  function renderTasks() {
    var host = document.getElementById('doc-tasks');
    if (!current.tasks.length) {
      host.innerHTML = '<p class="admin-empty">No tasks yet. Add the first one below.</p>';
      return;
    }
    host.innerHTML = current.tasks.map(taskHtml).join('');
  }

  function renderTotals() {
    var c = calc(current);
    var vatLine = current.vat_rate
      ? '<div class="admin-tot"><span>VAT at ' + esc(current.vat_rate) + '%</span><span>' + money(c.vat) + '</span></div>'
      : '';
    document.getElementById('doc-totals').innerHTML =
      '<div class="admin-tot"><span>Materials cost you</span><span>' + money(c.matsCost) + '</span></div>' +
      '<div class="admin-tot"><span>Materials charged</span><span>' + money(c.matsCharge) + '</span></div>' +
      '<div class="admin-tot"><span>Profit on materials</span><span class="admin-tot__profit">' + money(c.matsProfit) + '</span></div>' +
      '<div class="admin-tot"><span>Labour</span><span>' + money(c.labour) + '</span></div>' +
      '<div class="admin-tot"><span>Subtotal</span><span>' + money(c.subtotal) + '</span></div>' +
      vatLine +
      '<div class="admin-tot admin-tot--big"><span>Total</span><span>' + money(c.total) + '</span></div>';
  }

  function renderBuilder() {
    var type = TYPES[current.doc_type];

    document.getElementById('doc-builder-title').textContent =
      (current.id ? 'Edit ' : 'New ') + type.noun;

    var cameFrom = current.doc_type !== 'quote' && current.quote_ref;
    document.getElementById('doc-builder-sub').textContent = cameFrom
      ? 'Began as quote ' + current.quote_ref
      : (current.id ? '' : 'Change the reference if you number jobs differently.');

    document.getElementById('doc-ref').value = current.ref || '';
    document.getElementById('doc-issue_date').value = current.issue_date || today();
    document.getElementById('doc-title').value = current.title || '';
    document.getElementById('doc-customer_name').value = current.customer_name || '';
    document.getElementById('doc-customer_phone').value = current.customer_phone || '';
    document.getElementById('doc-customer_email').value = current.customer_email || '';
    document.getElementById('doc-job_address').value = current.job_address || '';
    document.getElementById('doc-notes').value = current.notes || '';
    document.getElementById('doc-vat_rate').value = current.vat_rate || 0;
    document.getElementById('doc-price_view').value = current.price_view || 'full';

    document.getElementById('doc-status').innerHTML = type.statuses.map(function (s) {
      return '<option value="' + esc(s.value) + '"' +
        (s.value === current.status ? ' selected' : '') + '>' + esc(s.label) + '</option>';
    }).join('');

    // Only an invoice has anything to be due.
    var dueField = document.getElementById('doc-due-field');
    dueField.hidden = current.doc_type !== 'invoice';
    document.getElementById('doc-due_date').value = current.due_date || '';

    renderTasks();
    renderTotals();
  }

  function readForm() {
    current.ref = document.getElementById('doc-ref').value.trim();
    current.issue_date = document.getElementById('doc-issue_date').value || today();
    current.status = document.getElementById('doc-status').value;
    current.due_date = document.getElementById('doc-due_date').value || null;
    current.title = document.getElementById('doc-title').value;
    current.customer_name = document.getElementById('doc-customer_name').value;
    current.customer_phone = document.getElementById('doc-customer_phone').value;
    current.customer_email = document.getElementById('doc-customer_email').value;
    current.job_address = document.getElementById('doc-job_address').value;
    current.notes = document.getElementById('doc-notes').value;
    current.vat_rate = Number(document.getElementById('doc-vat_rate').value) || 0;
    current.price_view = document.getElementById('doc-price_view').value;
  }

  function showList() {
    builderView.hidden = true;
    listView.hidden = false;
    renderList();
  }

  function showBuilder(doc) {
    current = doc;
    savedStatus = doc.id ? doc.status : null;
    dirty = false;
    listView.hidden = true;
    builderView.hidden = false;
    renderBuilder();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Asks what to do about unsaved changes.
   *
   * Three answers, which a confirm box cannot offer: keep working, throw the
   * changes away, or save them and carry on. Resolves to true when it is all
   * right to leave.
   */
  async function askAboutChanges() {
    var answer = await ask({
      title: 'You have unsaved changes',
      message: current && current.ref
        ? 'Do you want to save the changes to ' + current.ref + ' before you go?'
        : 'Do you want to save them before you go?',
      buttons: [
        { value: 'stay', label: 'Stay here' },
        { value: 'discard', label: 'Discard them' },
        { value: 'save', label: 'Save changes', primary: true },
      ],
    });
    return answer.action === 'cancel' ? 'stay' : answer.action;
  }

  async function leaveGuard() {
    if (builderView.hidden || !dirty) return true;

    var answer = await askAboutChanges();
    if (answer === 'stay') return false;
    if (answer === 'discard') {
      dirty = false;
      return true;
    }
    // Saving can still fail, on a duplicate reference or a missing one. Then
    // the changes are still here and leaving would lose them.
    return await save();
  }

  /* ------------------------------------------------------------- printing */

  /**
   * Prints once the logo has actually arrived.
   *
   * Calling window.print() straight after setting the markup prints whatever
   * has loaded so far, and an image requested a moment ago has not. That is
   * why the logo was missing from the first print of a session.
   */
  function printWhenReady() {
    var images = [].slice.call(document.getElementById('doc-print').querySelectorAll('img'));
    var waiting = images.filter(function (img) { return !img.complete; });
    if (!waiting.length) {
      window.print();
      return;
    }
    var left = waiting.length;
    var go = function () {
      if (--left === 0) window.print();
    };
    waiting.forEach(function (img) {
      img.addEventListener('load', go, { once: true });
      img.addEventListener('error', go, { once: true });
    });
  }

  /**
   * What the customer sees when they are shown one price and no breakdown.
   *
   * The work is still described, because a bare figure with nothing against it
   * is not a quotation. Only the money is left off.
   */
  function listOfWork() {
    var named = current.tasks.filter(function (t) { return t.name; });
    if (!named.length) return '';
    return '<section class="task"><h3>The work</h3><ul class="work">' +
      named.map(function (t) { return '<li>' + esc(t.name) + '</li>'; }).join('') +
      '</ul></section>';
  }

  function buildPrintDocument() {
    readForm();
    var c = calc(current);
    var type = TYPES[current.doc_type];
    // Three levels of detail on the customer's copy: everything, task totals
    // only, or a single figure with no breakdown at all.
    var summary = current.price_view === 'summary';
    var totalsOnly = current.price_view === 'totals';
    var isInvoice = current.doc_type === 'invoice';

    var tasks = totalsOnly ? listOfWork() : current.tasks.map(function (t, i) {
      var mats = t.materials.filter(function (m) { return m.name || matCharge(m) > 0; });

      var head = summary
        ? '<tr><th>Material</th><th class="n">Qty</th></tr>'
        : '<tr><th>Material</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Amount</th></tr>';

      var rows = mats.map(function (m) {
        if (summary) {
          return '<tr><td>' + esc(m.name) + '</td><td class="n">' + esc(m.qty) + '</td></tr>';
        }
        return '<tr><td>' + esc(m.name) + '</td><td class="n">' + esc(m.qty) + '</td>' +
          '<td class="n">' + money(matCharge(m) / (+m.qty || 1)) + '</td>' +
          '<td class="n">' + money(matCharge(m)) + '</td></tr>';
      }).join('');

      var labourRow = '';
      if (!summary) {
        var howLong = t.labourType === 'hourly' ? ' (' + esc(t.qty) + ' hours)'
          : t.labourType === 'day' ? ' (' + esc(t.qty) + ' days)' : '';
        labourRow = '<tr><td>Labour' + howLong + '</td><td class="n">' + money(taskLabour(t)) + '</td></tr>';
      }

      // Wrapped so a task and its figures are kept together on one sheet
      // rather than being split down the middle by a page break.
      return '<section class="task">' +
        '<h3>' + (i + 1) + '. ' + esc(t.name || 'Task ' + (i + 1)) + '</h3>' +
        (mats.length ? '<table><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>' : '') +
        '<table><tbody>' + labourRow +
          '<tr><td><strong>Task total, materials and labour</strong></td>' +
          '<td class="n"><strong>' + money(taskTotal(t)) + '</strong></td></tr>' +
        '</tbody></table>' +
      '</section>';
    }).join('');

    var vatNumber = setting('vat_number', '');
    var terms = Math.trunc(num('payment_terms_days', 14));

    var payment = '';
    if (isInvoice) {
      var bank = [
        setting('bank_account_name', '') ? 'Account name: ' + esc(setting('bank_account_name', '')) : '',
        setting('bank_sort_code', '') ? 'Sort code: ' + esc(setting('bank_sort_code', '')) : '',
        setting('bank_account_number', '') ? 'Account number: ' + esc(setting('bank_account_number', '')) : '',
      ].filter(Boolean).join('<br>');

      payment = '<div class="pay"><h3>How to pay</h3>' +
        '<p>Payment is due within ' + terms + ' days' +
        (current.due_date ? ', by ' + esc(ukDate(current.due_date)) : '') + '.</p>' +
        (bank ? '<p>' + bank + '</p>' : '') +
        '<p>Please quote ' + esc(current.ref) + ' with your payment.</p></div>';
    }

    document.getElementById('doc-print').innerHTML =
      '<div class="head">' +
        '<div>' +
          '<img src="/Media/logo.png" alt="" width="260" height="228">' +
          '<p class="biz">' + esc(setting('business_name', 'Shaws Carpentry')) + '</p>' +
          '<p>' + esc(setting('business_address', '')) + '</p>' +
          '<p>' + esc(setting('phone_display', '')) + '</p>' +
          '<p>' + esc(setting('email', '')) + '</p>' +
          (isInvoice && vatNumber ? '<p>VAT number ' + esc(vatNumber) + '</p>' : '') +
        '</div>' +
        '<div class="meta">' +
          '<p class="kind">' + esc(type.heading) + '</p>' +
          '<p>' + esc(current.ref) + '</p>' +
          '<p>' + esc(ukDate(current.issue_date)) + '</p>' +
          (isInvoice && current.due_date ? '<p>Due ' + esc(ukDate(current.due_date)) + '</p>' : '') +
        '</div>' +
      '</div>' +

      '<div class="who">' +
        (current.customer_name ? '<p><strong>For</strong> ' + esc(current.customer_name) + '</p>' : '') +
        (current.job_address ? '<p><strong>Job address</strong> ' + esc(current.job_address) + '</p>' : '') +
        (current.title ? '<p><strong>Job</strong> ' + esc(current.title) + '</p>' : '') +
      '</div>' +

      tasks +

      '<div class="totals">' +
        (summary || totalsOnly ? '' :
          '<div><span>Materials</span><span>' + money(c.matsCharge) + '</span></div>' +
          '<div><span>Labour</span><span>' + money(c.labour) + '</span></div>') +
        '<div><span>Subtotal</span><span>' + money(c.subtotal) + '</span></div>' +
        (current.vat_rate
          ? '<div><span>VAT at ' + esc(current.vat_rate) + '%</span><span>' + money(c.vat) + '</span></div>'
          : '') +
        '<div class="grand"><span>Total</span><span>' + money(c.total) + '</span></div>' +
      '</div>' +

      payment +
      (current.notes ? '<div class="notes"><strong>Notes</strong><br>' + esc(current.notes) + '</div>' : '') +

      // Repeated at the foot of every page by the print stylesheet, so a
      // second sheet is still identifiable on its own.
      '<div class="running-foot">' + esc(setting('business_name', '')) + ' · ' +
        esc(type.heading.toLowerCase()) + ' ' + esc(current.ref) + '</div>';
  }

  var printingFromButton = false;

  function printDocument() {
    buildPrintDocument();
    printingFromButton = true;
    printWhenReady();
  }

  // Ctrl+P should print the job on screen, not an empty page. Without this,
  // printing any way other than the button gives a sheet with nothing on it.
  // The flag matters: rebuilding here after the button has already waited for
  // the logo would throw that away and print without it.
  window.addEventListener('beforeprint', function () {
    if (printingFromButton) return;
    if (builderView.hidden || !current) return;
    buildPrintDocument();
  });

  window.addEventListener('afterprint', function () {
    printingFromButton = false;
  });

  /* -------------------------------------------------------------- loading */

  async function load() {
    state.documents = (await api('/documents')).items;
    state.loaded = true;
    renderList();
    renderDefaults();
  }

  /* --------------------------------------------------------------- events */

  // New quote or invoice.
  document.querySelectorAll('[data-new]').forEach(function (button) {
    button.addEventListener('click', async function () {
      if (!(await leaveGuard())) return;
      showBuilder(blankDocument(button.getAttribute('data-new')));
    });
  });

  // Filters.
  document.querySelectorAll('[data-doctype]').forEach(function (button) {
    button.addEventListener('click', function () {
      state.type = button.getAttribute('data-doctype');
      state.status = 'all';
      renderList();
    });
  });

  document.getElementById('doc-status-filter').addEventListener('click', function (e) {
    var button = e.target.closest('[data-docstatus]');
    if (!button) return;
    state.status = button.getAttribute('data-docstatus');
    renderList();
  });

  // List actions.
  document.getElementById('list-documents').addEventListener('click', async function (e) {
    var row = e.target.closest('.admin-doc');
    if (!row) return;
    var id = Number(row.getAttribute('data-id'));
    var doc = state.documents.filter(function (d) { return d.id === id; })[0];
    if (!doc) return;

    var convertTo = e.target.closest('[data-convert]');
    if (convertTo) {
      var to = convertTo.getAttribute('data-convert');
      if (!(await confirmAsk('Turn this into an invoice?',
        doc.ref + ' keeps its history, but it stops being a quote.',
        'Make it an invoice'))) return;

      var newRef = await promptAsk('Reference for the invoice',
        'Change it if you number invoices differently', suggestRef(to), 'Create the invoice');
      if (newRef === null) return;
      if (!newRef) {
        say('It needs a reference.', 'error');
        return;
      }

      try {
        var converted = await api('/documents/' + id + '/convert', {
          method: 'POST', body: JSON.stringify({ to: to, ref: newRef }),
        });
        say('Now ' + converted.item.ref + '.');
        await load();
        // Straight into it: converting is almost always the first half of
        // "and now fill in the invoice".
        showBuilder(converted.item);
      } catch (err) {
        say(err.message, 'error');
      }
      return;
    }

    var action = e.target.closest('[data-doc-action]');
    if (!action) return;
    var what = action.getAttribute('data-doc-action');

    if (what === 'open') {
      if (!(await leaveGuard())) return;
      showBuilder(JSON.parse(JSON.stringify(doc)));
      return;
    }

    if (what === 'duplicate') {
      var copy = JSON.parse(JSON.stringify(doc));
      copy.id = null;
      copy.ref = suggestRef(copy.doc_type);
      copy.quote_ref = null;
      copy.order_ref = null;
      copy.invoice_ref = null;
      copy.issue_date = today();
      copy.due_date = null;
      copy.status = TYPES[copy.doc_type].statuses[0].value;
      copy.tasks.forEach(function (t) {
        t.id = uid();
        t.materials.forEach(function (m) { m.id = uid(); });
      });
      if (!(await leaveGuard())) return;
      showBuilder(copy);
      say('A copy, not saved yet. Save it to give it a reference.');
      return;
    }

    if (what === 'delete') {
      if (!(await confirmAsk('Delete this?', 'Deleting ' + doc.ref + ' cannot be undone.',
        'Delete', true))) return;
      try {
        await api('/documents/' + id, { method: 'DELETE' });
        say('Deleted.');
        await load();
      } catch (err) {
        say(err.message, 'error');
      }
    }
  });

  // Starting figures.
  document.getElementById('doc-defaults-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var body = {};
    Array.prototype.forEach.call(e.target.elements, function (el) {
      if (el.name) body[el.name] = el.value;
    });
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
      Object.keys(body).forEach(function (k) { window.Admin.settings()[k] = body[k]; });
      say('Saved. New jobs will start from these.');
    } catch (err) {
      say(err.message, 'error');
    }
  });

  /* ---- the builder ---- */

  builderView.addEventListener('input', function (e) {
    var taskIndex = e.target.getAttribute('data-task');
    if (taskIndex === null) {
      dirty = true;
      if (e.target.id === 'doc-vat_rate') {
        current.vat_rate = Number(e.target.value) || 0;
        renderTotals();
      }
      return;
    }

    var task = current.tasks[Number(taskIndex)];
    if (!task) return;
    var field = e.target.getAttribute('data-field');
    var materialIndex = e.target.getAttribute('data-material');
    var target = materialIndex === null ? task : task.materials[Number(materialIndex)];
    if (!target || !field) return;

    target[field] = field === 'name' ? e.target.value : Number(e.target.value) || 0;
    dirty = true;

    // Redrawing on every keystroke would take the focus out of the box being
    // typed in, so only the figures are refreshed here.
    renderTotals();
    refreshTaskSubtotals();
  });

  builderView.addEventListener('change', function (e) {
    var field = e.target.getAttribute('data-field');

    // Setting a price by hand switches the markup box off, and clearing it
    // switches it back on. Done on leaving the box rather than on each
    // keystroke, which would take the focus away mid-type.
    if (field === 'price') {
      renderTasks();
      renderTotals();
      return;
    }

    if (field !== 'labourType') return;
    var task = current.tasks[Number(e.target.getAttribute('data-task'))];
    if (!task) return;

    task.labourType = e.target.value;
    if (task.labourType === 'day') task.rate = num('quote_day_rate', 250);
    if (task.labourType === 'hourly') task.rate = num('quote_hourly_rate', 35);
    dirty = true;
    renderTasks();
    renderTotals();
  });

  // The subtotal lines under each task, without redrawing the inputs.
  function refreshTaskSubtotals() {
    var cards = document.querySelectorAll('#doc-tasks .admin-task');
    current.tasks.forEach(function (task, i) {
      var card = cards[i];
      if (!card) return;
      var sub = card.querySelector('.admin-task__sub');
      if (sub) {
        sub.innerHTML =
          '<span>Materials <strong>' + money(taskMatsCharge(task)) + '</strong></span>' +
          '<span>Labour <strong>' + money(taskLabour(task)) + '</strong></span>' +
          '<span>Task total <strong>' + money(taskTotal(task)) + '</strong></span>';
      }
      var cells = card.querySelectorAll('tbody tr');
      task.materials.forEach(function (m, mi) {
        var cell = cells[mi];
        if (!cell) return;
        var numbers = cell.querySelectorAll('.admin-doc__num');
        if (numbers[0]) numbers[0].textContent = money(matCost(m));
        if (numbers[1]) numbers[1].innerHTML = '<strong>' + money(matCharge(m)) + '</strong>';

        // The folded header on a phone shows the name and the charge, so it
        // has to keep up with what is being typed underneath it.
        var name = cell.querySelector('.admin-task__toggle-name');
        var sum = cell.querySelector('.admin-task__toggle-sum');
        if (name) name.textContent = m.name || 'New material';
        if (sum) sum.textContent = money(matCharge(m));
      });
    });
  }

  builderView.addEventListener('click', async function (e) {
    var taskAction = e.target.closest('[data-task-action]');
    if (taskAction) {
      var i = Number(taskAction.getAttribute('data-task'));
      var what = taskAction.getAttribute('data-task-action');
      if (what === 'add-material') {
        current.tasks[i].materials.push(blankMaterial());
        // The new one opens, which folds away whatever was open before.
        openMaterial = i + ':' + (current.tasks[i].materials.length - 1);
      } else if (what === 'delete') {
        if (!(await confirmAsk('Delete this task?',
          'The task and its materials go with it.', 'Delete', true))) return;
        current.tasks.splice(i, 1);
      }
      dirty = true;
      renderTasks();
      renderTotals();
      return;
    }

    var materialAction = e.target.closest('[data-material-action]');
    if (materialAction) {
      var ti = Number(materialAction.getAttribute('data-task'));
      var mi = Number(materialAction.getAttribute('data-material'));
      var key = ti + ':' + mi;

      if (materialAction.getAttribute('data-material-action') === 'toggle') {
        openMaterial = openMaterial === key ? null : key;
        renderTasks();
        return;
      }

      current.tasks[ti].materials.splice(mi, 1);
      if (openMaterial === key) openMaterial = null;
      dirty = true;
      renderTasks();
      renderTotals();
      return;
    }

    var button = e.target.closest('[data-doc]');
    if (!button) return;
    var action = button.getAttribute('data-doc');

    if (action === 'add-task') {
      current.tasks.push(blankTask());
      dirty = true;
      renderTasks();
      renderTotals();
      return;
    }

    if (action === 'back') {
      if (!(await leaveGuard())) return;
      showList();
      return;
    }

    if (action === 'print') {
      printDocument();
      return;
    }

    if (action === 'save') await save();
  });

  /** Returns true when the job is safely stored. */
  async function save() {
    readForm();

    if (!current.ref) {
      say('Give it a reference before saving.', 'error');
      document.getElementById('doc-ref').focus();
      return false;
    }

    // An invoice that has gone out is a record. Changing one quietly is the
    // kind of thing that is hard to explain later, so ask first.
    //
    // Judged on the status it had when it was opened, not the one in the box.
    // Marking a draft as Sent is not editing a sent invoice, and asking then
    // was simply wrong.
    if (current.id && current.doc_type === 'invoice' && savedStatus !== 'draft') {
      if (!(await confirmAsk('This invoice has already gone out',
        'You are changing ' + current.ref + ' after it was marked ' +
        statusLabel({ doc_type: 'invoice', status: savedStatus }).toLowerCase() +
        '. Change it anyway?', 'Change it'))) return false;
    }

    var body = {
      ref: current.ref,
      doc_type: current.doc_type,
      status: current.status,
      issue_date: current.issue_date,
      due_date: current.due_date || '',
      title: current.title,
      customer_name: current.customer_name,
      customer_phone: current.customer_phone,
      customer_email: current.customer_email,
      job_address: current.job_address,
      notes: current.notes,
      vat_rate: current.vat_rate,
      price_view: current.price_view,
      tasks: current.tasks,
    };

    try {
      var saved;
      if (current.id) {
        saved = await api('/documents/' + current.id, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        saved = await api('/documents', { method: 'POST', body: JSON.stringify(body) });
      }
      current = saved.item;
      savedStatus = current.status;
      dirty = false;
      renderBuilder();
      say('Saved as ' + current.ref + '.');
      await load();
      return true;
    } catch (err) {
      say(err.message, 'error');
      return false;
    }
  }

  /* ----------------------------------------------------------------- open */

  // Closing or reloading the window. The browser will not show our own words
  // here, only its own warning, but the changes are at least not lost silently.
  window.addEventListener('beforeunload', function (e) {
    if (builderView.hidden || !dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  window.AdminDocuments = {
    // Asked by admin.js before it switches tab, so leaving this section by any
    // route goes through the same question.
    canLeave: leaveGuard,

    open: async function () {
      // Pressing the tab while a job is open puts it back to the list, the
      // same as the button does. Coming back to a section should show where it
      // starts, not wherever you happened to leave off. Anything unsaved has
      // already been asked about by canLeave.
      if (!builderView.hidden) showList();

      if (state.loaded) {
        renderDefaults();
        return;
      }
      try {
        await load();
      } catch (err) {
        say(err.message, 'error');
      }
    },
  };
})();
