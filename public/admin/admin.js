/* Admin area behaviour.
 *
 * Talks to /api/*, which sits behind the same Cloudflare Access login as this
 * page, so there is no separate sign-in to handle here.
 */

(function () {
  'use strict';

  var state = { services: [], gallery: [], testimonials: [], settings: {}, photos: [] };

  var statusEl = document.getElementById('status');
  var editor = document.getElementById('editor');
  var editorForm = document.getElementById('editor-form');
  var editorFields = document.getElementById('editor-fields');
  var editorTitle = document.getElementById('editor-title');
  var editorError = document.getElementById('editor-error');
  var statusTimer = null;

  /* ------------------------------------------------------------- helpers */

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    }

  function say(message, kind) {
    statusEl.textContent = message;
    statusEl.className = 'admin-status is-visible ' + (kind === 'error' ? 'is-error' : 'is-success');
    window.clearTimeout(statusTimer);
    if (kind !== 'error') {
      statusTimer = window.setTimeout(function () {
        statusEl.className = 'admin-status';
      }, 4000);
    }
    statusEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function api(path, options) {
    var response = await fetch('/api' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, options));

    if (response.status === 403) {
      throw new Error('Your session has expired. Refresh the page to sign in again.');
    }

    var payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      throw new Error('The server sent back something unexpected.');
    }

    if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'Request failed.');
    return payload;
  }

  /* ---------------------------------------------------------- field specs */

  var FIELDS = {
    services: [
      { name: 'title', label: 'Name', type: 'text', required: true },
      { name: 'description', label: 'Description', type: 'textarea', required: true },
      {
        name: 'category', label: 'Type of work', type: 'select', required: true,
        options: [
          { value: 'domestic', label: 'Domestic (homes)' },
          { value: 'commercial', label: 'Commercial (business premises)' },
        ],
      },
      { name: 'image_key', label: 'Photo', type: 'photo' },
      { name: 'image_alt', label: 'Photo description', type: 'text',
        hint: 'Describes the photo for people using a screen reader.' },
      { name: 'featured', label: 'Show on the home page', type: 'check' },
      { name: 'published', label: 'Visible on the website', type: 'check' },
    ],
    gallery: [
      { name: 'caption', label: 'Caption', type: 'text', required: true },
      { name: 'image_key', label: 'Photo', type: 'photo', required: true },
      { name: 'image_alt', label: 'Photo description', type: 'text',
        hint: 'Describes the photo for people using a screen reader.' },
      { name: 'published', label: 'Visible on the website', type: 'check' },
    ],
    testimonials: [
      { name: 'quote', label: 'What they said', type: 'textarea', required: true,
        hint: 'No need for quotation marks, they are added automatically.' },
      { name: 'author_name', label: 'Customer name', type: 'text', required: true },
      { name: 'author_town', label: 'Town', type: 'text' },
      { name: 'published', label: 'Visible on the website', type: 'check' },
    ],
  };

  var TITLES = {
    services: { add: 'Add a service', edit: 'Edit service', key: 'title' },
    gallery: { add: 'Add a photo', edit: 'Edit photo', key: 'caption' },
    testimonials: { add: 'Add a review', edit: 'Edit review', key: 'author_name' },
  };

  /* -------------------------------------------------------------- render */

  function itemRow(collection, item, index, total) {
    var t = TITLES[collection];
    var title = item[t.key] || '(untitled)';
    var meta = collection === 'services' ? item.description
      : collection === 'gallery' ? (item.image_alt || item.image_key)
      : item.quote;

    var badges = '';
    if (collection === 'services' && item.featured) {
      badges += '<span class="admin-item__badge admin-item__badge--featured">Home page</span>';
    }
    if (!item.published) {
      badges += '<span class="admin-item__badge admin-item__badge--hidden">Hidden</span>';
    }

    var thumb = item.image_key
      ? '<img class="admin-item__thumb" src="' + esc(item.image_key) + '" alt="">'
      : '<span class="admin-item__thumb admin-item__thumb--empty"></span>';

    return '' +
      '<div class="admin-item' + (item.published ? '' : ' is-unpublished') + '" data-id="' + item.id + '">' +
        '<div class="admin-item__move">' +
          '<button type="button" data-move="up" aria-label="Move up"' + (index === 0 ? ' disabled' : '') + '>&uarr;</button>' +
          '<button type="button" data-move="down" aria-label="Move down"' + (index === total - 1 ? ' disabled' : '') + '>&darr;</button>' +
        '</div>' +
        thumb +
        '<div class="admin-item__body">' +
          '<p class="admin-item__title">' + esc(title) + badges + '</p>' +
          '<p class="admin-item__meta">' + esc(meta || '') + '</p>' +
        '</div>' +
        '<div class="admin-item__actions">' +
          '<button type="button" class="admin-btn-small" data-action="edit">Edit</button>' +
          '<button type="button" class="admin-btn-small" data-action="toggle">' +
            (item.published ? 'Hide' : 'Show') + '</button>' +
          '<button type="button" class="admin-btn-small admin-btn-small--danger" data-action="delete">Delete</button>' +
        '</div>' +
      '</div>';
  }

  function renderList(el, collection, items, emptyMessage) {
    if (!items.length) {
      el.innerHTML = '<p class="admin-empty">' + esc(emptyMessage) + '</p>';
      return;
    }
    el.innerHTML = items.map(function (item, i) {
      return itemRow(collection, item, i, items.length);
    }).join('');
  }

  function render() {
    var domestic = state.services.filter(function (s) { return s.category === 'domestic'; });
    var commercial = state.services.filter(function (s) { return s.category === 'commercial'; });

    renderList(document.getElementById('list-services-domestic'), 'services', domestic,
      'No domestic services yet.');
    renderList(document.getElementById('list-services-commercial'), 'services', commercial,
      'No commercial services yet.');
    renderList(document.getElementById('list-gallery'), 'gallery', state.gallery,
      'No photos yet. Add one to fill the Our Work page.');
    renderList(document.getElementById('list-testimonials'), 'testimonials', state.testimonials,
      'No reviews yet. The home page is showing "Reviews coming soon".');

    Object.keys(state.settings).forEach(function (key) {
      var input = document.querySelector('#settings-form [name="' + key + '"]');
      if (input) input.value = state.settings[key];
    });
  }

  /* -------------------------------------------------------------- editor */

  function fieldHtml(field, value) {
    var id = 'f-' + field.name;
    var hint = field.hint ? '<p class="admin-hint">' + esc(field.hint) + '</p>' : '';

    if (field.type === 'check') {
      return '<div class="admin-check">' +
        '<input type="checkbox" id="' + id + '" name="' + field.name + '"' + (value ? ' checked' : '') + '>' +
        '<label for="' + id + '">' + esc(field.label) + '</label></div>';
    }

    var control;
    if (field.type === 'textarea') {
      control = '<textarea id="' + id + '" name="' + field.name + '"' +
        (field.required ? ' required' : '') + '>' + esc(value || '') + '</textarea>';
    } else if (field.type === 'select') {
      control = '<select id="' + id + '" name="' + field.name + '"' + (field.required ? ' required' : '') + '>' +
        field.options.map(function (o) {
          return '<option value="' + esc(o.value) + '"' + (o.value === value ? ' selected' : '') + '>' +
            esc(o.label) + '</option>';
        }).join('') + '</select>';
    } else if (field.type === 'photo') {
      var options = ['<option value="">No photo</option>'].concat(
        state.photos.map(function (p) {
          return '<option value="' + esc(p) + '"' + (p === value ? ' selected' : '') + '>' +
            esc(p.replace(/^\/Media\//, '').replace(/^\/img\//, 'uploaded: ')) + '</option>';
        })
      ).join('');
      control = '<select id="' + id + '" name="' + field.name + '" data-photo-select' +
        (field.required ? ' required' : '') + '>' + options + '</select>' +
        (value ? '<img class="admin-thumb-preview" id="preview-' + field.name + '" src="' + esc(value) + '" alt="">' : '');
    } else {
      control = '<input type="text" id="' + id + '" name="' + field.name + '" value="' + esc(value || '') + '"' +
        (field.required ? ' required' : '') + '>';
    }

    return '<div class="admin-field"><label for="' + id + '">' + esc(field.label) +
      '</label>' + control + hint + '</div>';
  }

  var editing = { collection: null, id: null };

  function openEditor(collection, item) {
    editing.collection = collection;
    editing.id = item ? item.id : null;
    editorTitle.textContent = item ? TITLES[collection].edit : TITLES[collection].add;
    editorError.hidden = true;

    var defaults = item || (collection === 'services'
      ? { category: 'domestic', published: 1 }
      : collection === 'gallery' ? { published: 1 } : { published: 0 });

    editorFields.innerHTML = FIELDS[collection]
      .map(function (f) { return fieldHtml(f, defaults[f.name]); })
      .join('');

    editor.showModal();
  }

  editorFields.addEventListener('change', function (e) {
    if (!e.target.matches('[data-photo-select]')) return;
    var preview = document.getElementById('preview-' + e.target.name);
    if (e.target.value) {
      if (preview) {
        preview.src = e.target.value;
      } else {
        var img = document.createElement('img');
        img.className = 'admin-thumb-preview';
        img.id = 'preview-' + e.target.name;
        img.alt = '';
        img.src = e.target.value;
        e.target.parentNode.appendChild(img);
      }
    } else if (preview) {
      preview.remove();
    }
  });

  editorForm.addEventListener('submit', async function (e) {
    if (editorForm.returnValue === 'cancel') return;
    var submitter = e.submitter;
    if (submitter && submitter.value === 'cancel') return;

    e.preventDefault();

    var collection = editing.collection;
    var body = {};
    FIELDS[collection].forEach(function (field) {
      var input = editorForm.elements[field.name];
      if (!input) return;
      body[field.name] = field.type === 'check' ? input.checked : input.value;
    });

    if (editing.id === null) {
      var siblings = collection === 'services'
        ? state.services.filter(function (s) { return s.category === body.category; })
        : state[collection];
      body.sort_order = siblings.length + 1;
    }

    try {
      if (editing.id === null) {
        await api('/' + collection, { method: 'POST', body: JSON.stringify(body) });
        say('Added. It is live on the website now.');
      } else {
        await api('/' + collection + '/' + editing.id, { method: 'PUT', body: JSON.stringify(body) });
        say('Saved. The website is updated.');
      }
      editor.close();
      await load();
    } catch (err) {
      editorError.textContent = err.message;
      editorError.hidden = false;
    }
  });

  /* ------------------------------------------------------------- actions */

  function collectionFor(el) {
    var panel = el.closest('.admin-panel');
    return panel ? panel.id.replace('panel-', '') : null;
  }

  function itemsFor(collection, item) {
    if (collection !== 'services') return state[collection];
    return state.services.filter(function (s) { return s.category === item.category; });
  }

  document.addEventListener('click', async function (e) {
    var addBtn = e.target.closest('[data-add]');
    if (addBtn) {
      openEditor(addBtn.getAttribute('data-add'), null);
      return;
    }

    var row = e.target.closest('.admin-item');
    if (!row) return;

    var collection = collectionFor(row);
    var id = Number(row.getAttribute('data-id'));
    var item = state[collection].find(function (i) { return i.id === id; });
    if (!item) return;

    var moveBtn = e.target.closest('[data-move]');
    if (moveBtn) {
      var siblings = itemsFor(collection, item);
      var index = siblings.findIndex(function (s) { return s.id === id; });
      var target = moveBtn.getAttribute('data-move') === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= siblings.length) return;

      var reordered = siblings.slice();
      reordered.splice(target, 0, reordered.splice(index, 1)[0]);

      try {
        await api('/' + collection + '/reorder', {
          method: 'POST',
          body: JSON.stringify(reordered.map(function (s, i) {
            return { id: s.id, sort_order: i + 1 };
          })),
        });
        await load();
      } catch (err) {
        say(err.message, 'error');
      }
      return;
    }

    var actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;
    var action = actionBtn.getAttribute('data-action');

    if (action === 'edit') {
      openEditor(collection, item);
      return;
    }

    if (action === 'toggle') {
      try {
        await api('/' + collection + '/' + id, {
          method: 'PUT',
          body: JSON.stringify({ published: !item.published }),
        });
        say(item.published ? 'Hidden from the website.' : 'Now visible on the website.');
        await load();
      } catch (err) {
        say(err.message, 'error');
      }
      return;
    }

    if (action === 'delete') {
      var label = item[TITLES[collection].key] || 'this item';
      if (!window.confirm('Delete "' + label + '"? This cannot be undone.')) return;
      try {
        await api('/' + collection + '/' + id, { method: 'DELETE' });
        say('Deleted.');
        await load();
      } catch (err) {
        say(err.message, 'error');
      }
    }
  });

  /* ------------------------------------------------------------ settings */

  document.getElementById('settings-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var body = {};
    Array.prototype.forEach.call(e.target.elements, function (el) {
      if (el.name) body[el.name] = el.value;
    });
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
      say('Contact details saved.');
      await load();
    } catch (err) {
      say(err.message, 'error');
    }
  });

  /* ---------------------------------------------------------------- tabs */

  document.querySelectorAll('.admin-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.admin-tab').forEach(function (t) {
        t.removeAttribute('aria-current');
      });
      tab.setAttribute('aria-current', 'page');
      document.querySelectorAll('.admin-panel').forEach(function (panel) {
        panel.classList.toggle('is-active', panel.id === 'panel-' + tab.getAttribute('data-tab'));
      });
    });
  });

  /* ---------------------------------------------------------------- load */

  async function load() {
    var content = await api('/content');
    state.services = content.services;
    state.gallery = content.gallery;
    state.testimonials = content.testimonials;
    state.settings = content.settings;
    try {
      state.photos = (await api('/photos')).photos;
    } catch (err) {
      state.photos = [];
    }
    render();
  }

  load()
    .then(function () {
      document.getElementById('signed-in-as').textContent =
        state.settings.email ? 'Signed in for ' + state.settings.email : 'Signed in';
    })
    .catch(function (err) {
      say(err.message, 'error');
    });
})();
