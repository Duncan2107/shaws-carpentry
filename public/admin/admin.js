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
      { name: 'show_on_services', label: 'Show on the Services page', type: 'check',
        hint: 'Also decides whether it appears in the enquiry form’s dropdown.' },
      { name: 'show_on_home', label: 'Show on the home page', type: 'check' },
    ],
    gallery: [
      { name: 'caption', label: 'Caption', type: 'text', required: true },
      { name: 'images', label: 'Photos', type: 'images',
        hint: 'Add as many as you like. The first is the cover shown on the Our Work page, and visitors swipe or click through the rest.' },
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

  function coverOf(item) {
    if (item.images && item.images.length) return item.images[0].image_key;
    return item.image_key || '';
  }

  // Services have two switches rather than one, so "visible" means it appears
  // on at least one page.
  function isVisible(collection, item) {
    if (collection === 'services') return !!(item.show_on_home || item.show_on_services);
    return !!item.published;
  }

  function itemRow(collection, item, index, total) {
    var t = TITLES[collection];
    var title = item[t.key] || '(untitled)';
    var photoCount = item.images ? item.images.length : 0;
    var meta = collection === 'services' ? item.description
      : collection === 'gallery'
        ? (photoCount === 1 ? '1 photo' : photoCount + ' photos')
      : item.quote;

    var badges = '';
    if (collection === 'services') {
      if (item.show_on_home) {
        badges += '<span class="admin-item__badge admin-item__badge--featured">Home page</span>';
      }
      if (!item.show_on_services) {
        badges += '<span class="admin-item__badge admin-item__badge--hidden">Not on Services</span>';
      }
      if (!item.show_on_home && !item.show_on_services) {
        badges += '<span class="admin-item__badge admin-item__badge--hidden">Hidden</span>';
      }
    } else {
      if (collection === 'gallery' && photoCount > 1) {
        badges += '<span class="admin-item__badge admin-item__badge--featured">Carousel</span>';
      }
      if (!item.published) {
        badges += '<span class="admin-item__badge admin-item__badge--hidden">Hidden</span>';
      }
    }

    var cover = coverOf(item);
    var thumb = cover
      ? '<img class="admin-item__thumb" src="' + esc(cover) + '" alt="">'
      : '<span class="admin-item__thumb admin-item__thumb--empty"></span>';

    var visible = isVisible(collection, item);
    return '' +
      '<div class="admin-item' + (visible ? '' : ' is-unpublished') + '" data-id="' + item.id + '">' +
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
            (visible ? 'Hide' : 'Show') + '</button>' +
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

  /* ---- uploading ---- */

  var MAX_EDGE = 1600;

  /**
   * Shrinks a photo in the browser before it is sent.
   *
   * Phone cameras produce 5-10MB files, which are far larger than anything
   * the site displays. Resizing here means the upload is quick on a phone
   * signal and the stored file is already the right size, rather than
   * shipping the full thing and dealing with it afterwards.
   */
  function shrinkImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        if (w > MAX_EDGE || h > MAX_EDGE) {
          var scale = MAX_EDGE / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error('Could not process that image.'));
        }, 'image/jpeg', 0.78);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That file does not look like an image.'));
      };
      img.src = url;
    });
  }

  async function uploadPhoto(file) {
    var blob = await shrinkImage(file);
    var form = new FormData();
    form.append('file', blob, 'photo.jpg');
    // No Content-Type header: the browser sets the multipart boundary.
    var response = await fetch('/api/upload', { method: 'POST', body: form });
    var payload = await response.json().catch(function () { return null; });
    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error : 'Upload failed.');
    }
    if (state.photos.indexOf(payload.url) === -1) state.photos.unshift(payload.url);
    return payload.url;
  }

  /* ---- multi-photo editor (gallery projects) ---- */

  var draftImages = [];

  function photoOptions(selected) {
    return ['<option value="">Choose a photo&hellip;</option>'].concat(
      state.photos.map(function (p) {
        return '<option value="' + esc(p) + '"' + (p === selected ? ' selected' : '') + '>' +
          esc(p.replace(/^\/Media\//, '').replace(/^\/img\//, 'uploaded: ')) + '</option>';
      })
    ).join('');
  }

  function renderDraftImages() {
    var host = document.getElementById('images-list');
    if (!host) return;

    if (!draftImages.length) {
      host.innerHTML = '<p class="admin-empty">No photos yet. Add at least one.</p>';
      return;
    }

    host.innerHTML = draftImages.map(function (img, i) {
      return '' +
        '<div class="admin-photo" data-i="' + i + '">' +
          '<img class="admin-photo__thumb" src="' + esc(img.image_key) + '" alt="">' +
          '<div class="admin-photo__body">' +
            '<select class="admin-photo__select" data-field="image_key">' + photoOptions(img.image_key) + '</select>' +
            '<input class="admin-photo__alt" data-field="image_alt" type="text" ' +
              'placeholder="Describe this photo (for screen readers)" value="' + esc(img.image_alt || '') + '">' +
            (i === 0 ? '<p class="admin-hint">Cover photo, shown on the Our Work page.</p>' : '') +
          '</div>' +
          '<div class="admin-photo__actions">' +
            '<button type="button" class="admin-btn-small" data-photo="up"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move photo up">&uarr;</button>' +
            '<button type="button" class="admin-btn-small" data-photo="down"' + (i === draftImages.length - 1 ? ' disabled' : '') + ' aria-label="Move photo down">&darr;</button>' +
            '<button type="button" class="admin-btn-small admin-btn-small--danger" data-photo="remove" aria-label="Remove photo">Remove</button>' +
          '</div>' +
        '</div>';
    }).join('');
  }

  // Delegated so it keeps working as rows are re-rendered.
  editorFields.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-photo]');
    if (btn) {
      e.preventDefault();
      var row = btn.closest('.admin-photo');
      var i = Number(row.getAttribute('data-i'));
      var action = btn.getAttribute('data-photo');
      if (action === 'remove') draftImages.splice(i, 1);
      if (action === 'up' && i > 0) draftImages.splice(i - 1, 0, draftImages.splice(i, 1)[0]);
      if (action === 'down' && i < draftImages.length - 1) {
        draftImages.splice(i + 1, 0, draftImages.splice(i, 1)[0]);
      }
      renderDraftImages();
      return;
    }

    if (e.target.id === 'images-add') {
      e.preventDefault();
      draftImages.push({ image_key: state.photos[0] || '', image_alt: '' });
      renderDraftImages();
    }
  }, false);

  // Uploads, from either the single-photo picker or the gallery editor.
  editorFields.addEventListener('change', async function (e) {
    if (e.target.type !== 'file') return;
    var files = Array.prototype.slice.call(e.target.files || []);
    if (!files.length) return;

    var label = e.target.closest('.admin-upload-btn');
    var original = label ? label.firstChild.nodeValue : null;
    if (label) label.firstChild.nodeValue = files.length > 1
      ? 'Uploading ' + files.length + ' photos...'
      : 'Uploading...';
    editorError.hidden = true;
    e.target.disabled = true;

    try {
      var urls = [];
      for (var i = 0; i < files.length; i++) urls.push(await uploadPhoto(files[i]));

      var forField = e.target.getAttribute('data-upload-for');
      if (forField) {
        // Single-photo picker: rebuild the options and select the new one.
        var select = editorForm.elements[forField];
        select.innerHTML = ['<option value="">No photo</option>'].concat(
          state.photos.map(function (p) {
            return '<option value="' + esc(p) + '">' +
              esc(p.replace(/^\/Media\//, '').replace(/^\/img\//, 'uploaded: ')) + '</option>';
          })
        ).join('');
        select.value = urls[0];
        select.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        urls.forEach(function (url) {
          draftImages.push({ image_key: url, image_alt: '' });
        });
        renderDraftImages();
      }
    } catch (err) {
      editorError.textContent = err.message;
      editorError.hidden = false;
    } finally {
      e.target.disabled = false;
      e.target.value = '';
      if (label && original !== null) label.firstChild.nodeValue = original;
    }
  });

  editorFields.addEventListener('input', function (e) {
    var row = e.target.closest('.admin-photo');
    if (!row) return;
    var i = Number(row.getAttribute('data-i'));
    var field = e.target.getAttribute('data-field');
    if (!field || !draftImages[i]) return;
    draftImages[i][field] = e.target.value;
    if (field === 'image_key') {
      row.querySelector('.admin-photo__thumb').src = e.target.value;
    }
  });

  function fieldHtml(field, value) {
    var id = 'f-' + field.name;
    var hint = field.hint ? '<p class="admin-hint">' + esc(field.hint) + '</p>' : '';

    if (field.type === 'images') {
      return '<div class="admin-field"><label>' + esc(field.label) + '</label>' + hint +
        '<div id="images-list" class="admin-photos"></div>' +
        '<div class="admin-upload-row">' +
          '<button type="button" class="admin-btn-small" id="images-add">Choose an existing photo</button>' +
          '<label class="admin-btn-small admin-upload-btn">Upload photos' +
            '<input type="file" accept="image/*" multiple hidden id="images-upload">' +
          '</label>' +
        '</div></div>';
    }

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
        '<label class="admin-btn-small admin-upload-btn">Upload a new photo' +
          '<input type="file" accept="image/*" hidden data-upload-for="' + field.name + '">' +
        '</label>' +
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
      ? { category: 'domestic', show_on_services: 1, show_on_home: 0 }
      : collection === 'gallery' ? { published: 1 } : { published: 0 });

    draftImages = (item && item.images ? item.images : []).map(function (img) {
      return { image_key: img.image_key, image_alt: img.image_alt || '' };
    });
    if (collection === 'gallery' && draftImages.length === 0) {
      draftImages = [{ image_key: state.photos[0] || '', image_alt: '' }];
    }

    editorFields.innerHTML = FIELDS[collection]
      .map(function (f) { return fieldHtml(f, defaults[f.name]); })
      .join('');
    renderDraftImages();

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
      if (field.type === 'images') {
        body.images = draftImages.filter(function (img) { return img.image_key; });
        return;
      }
      var input = editorForm.elements[field.name];
      if (!input) return;
      body[field.name] = field.type === 'check' ? input.checked : input.value;
    });

    if (body.images && body.images.length === 0) {
      editorError.textContent = 'Add at least one photo before saving.';
      editorError.hidden = false;
      return;
    }

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
      var visible = isVisible(collection, item);
      // Hiding a service takes it off both pages; showing it again puts it
      // back on the services page, which is where a service normally lives.
      var change = collection === 'services'
        ? (visible ? { show_on_home: false, show_on_services: false }
                   : { show_on_services: true })
        : { published: !item.published };
      try {
        await api('/' + collection + '/' + id, {
          method: 'PUT',
          body: JSON.stringify(change),
        });
        say(visible ? 'Hidden from the website.' : 'Now visible on the website.');
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

  /* ------------------------------------------------------------ visitors */

  var statsRange = 30;
  var statsData = null;

  function compact(n) {
    return n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
  }

  function deltaLabel(now, before) {
    if (!before) return null;
    var pct = Math.round(((now - before) / before) * 100);
    if (pct === 0) return { text: 'no change', dir: 'flat' };
    return {
      text: (pct > 0 ? '+' : '') + pct + '%',
      dir: pct > 0 ? 'up' : 'down',
    };
  }

  function statTile(label, value, delta, note) {
    var d = '';
    if (delta) {
      d = '<span class="admin-kpi__delta is-' + delta.dir + '">' + esc(delta.text) +
          ' <span class="admin-kpi__vs">vs previous ' + statsRange + ' days</span></span>';
    }
    return '<div class="admin-kpi">' +
      '<p class="admin-kpi__label">' + esc(label) + '</p>' +
      '<p class="admin-kpi__value">' + esc(compact(value)) + '</p>' +
      d + (note ? '<p class="admin-hint">' + esc(note) + '</p>' : '') +
      '</div>';
  }

  var shortDate = function (iso) {
    var d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };

  /**
   * Columns of visitors per day.
   *
   * One series, so no legend: the heading above already says what is plotted.
   * Only the busiest day is labelled directly; the axis and the tooltip carry
   * the rest, and the full numbers are in the table below.
   */
  function renderChart(daily) {
    var host = document.getElementById('chart');
    var max = daily.reduce(function (m, d) { return Math.max(m, d.visitors); }, 0);

    if (max === 0) {
      host.innerHTML = '<p class="admin-empty">No visits recorded yet. Figures appear here as people browse the site.</p>';
      return;
    }

    var W = 720, H = 220, padL = 34, padR = 8, padT = 18, padB = 26;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var band = plotW / daily.length;
    var barW = Math.min(24, Math.max(3, band - 2));   // 2px surface gap, capped
    var peak = daily.reduce(function (a, b) { return b.visitors > a.visitors ? b : a; }, daily[0]);

    // Round the axis top to something tidy.
    var step = max <= 5 ? 1 : max <= 20 ? 5 : max <= 60 ? 10 : Math.ceil(max / 4 / 25) * 25;
    var top = Math.ceil(max / step) * step;
    var ticks = [];
    for (var t = 0; t <= top; t += step) ticks.push(t);

    var y = function (v) { return padT + plotH - (v / top) * plotH; };

    var grid = ticks.map(function (t) {
      return '<line class="chart-grid" x1="' + padL + '" x2="' + (W - padR) +
        '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '"></line>' +
        '<text class="chart-tick" x="' + (padL - 6) + '" y="' + (y(t) + 3.5).toFixed(1) + '">' + t + '</text>';
    }).join('');

    var bars = daily.map(function (d, i) {
      var x = padL + i * band + (band - barW) / 2;
      var h = d.visitors === 0 ? 0 : Math.max(2, (d.visitors / top) * plotH);
      var label = shortDate(d.day) + ': ' + d.visitors + (d.visitors === 1 ? ' visitor' : ' visitors') +
                  ', ' + d.views + (d.views === 1 ? ' page view' : ' page views');
      if (h === 0) {
        return '<rect class="chart-hit" x="' + (padL + i * band) + '" y="' + padT +
          '" width="' + band + '" height="' + plotH + '"><title>' + esc(label) + '</title></rect>';
      }
      // Rounded at the data end, square at the baseline.
      var r = Math.min(4, barW / 2, h);
      var yTop = padT + plotH - h;
      var path = 'M' + x + ',' + (padT + plotH) +
                 'V' + (yTop + r) +
                 'a' + r + ',' + r + ' 0 0 1 ' + r + ',-' + r +
                 'h' + (barW - 2 * r) +
                 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
                 'V' + (padT + plotH) + 'Z';
      return '<path class="chart-bar" d="' + path + '"><title>' + esc(label) + '</title></path>' +
        '<rect class="chart-hit" x="' + (padL + i * band) + '" y="' + padT +
        '" width="' + band + '" height="' + plotH + '"><title>' + esc(label) + '</title></rect>';
    }).join('');

    // Label the busiest day only, and only if it will not collide with the edge.
    var peakIndex = daily.indexOf(peak);
    var peakX = padL + peakIndex * band + band / 2;
    var peakLabel = peak.visitors > 0
      ? '<text class="chart-peak" x="' + peakX.toFixed(1) + '" y="' + (y(peak.visitors) - 6).toFixed(1) +
        '" text-anchor="' + (peakIndex < 2 ? 'start' : peakIndex > daily.length - 3 ? 'end' : 'middle') + '">' +
        peak.visitors + '</text>'
      : '';

    var first = daily[0], last = daily[daily.length - 1];
    var axis =
      '<text class="chart-tick" x="' + padL + '" y="' + (H - 8) + '" text-anchor="start">' + esc(shortDate(first.day)) + '</text>' +
      '<text class="chart-tick" x="' + (W - padR) + '" y="' + (H - 8) + '" text-anchor="end">' + esc(shortDate(last.day)) + '</text>';

    host.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" preserveAspectRatio="xMidYMid meet" ' +
      'aria-label="Visitors per day for the last ' + daily.length + ' days. Busiest day ' +
      esc(shortDate(peak.day)) + ' with ' + peak.visitors + '.">' +
      grid + bars + peakLabel + axis +
      '</svg>';
  }

  function renderStats() {
    var d = statsData;
    document.getElementById('stat-tiles').innerHTML =
      statTile('Visitors', d.total.visitors, deltaLabel(d.total.visitors, d.previous.visitors)) +
      statTile('Page views', d.total.views, deltaLabel(d.total.views, d.previous.views)) +
      statTile('Pages per visit', d.total.visitors
        ? Math.round((d.total.views / d.total.visitors) * 10) / 10 : 0, null,
        'How much they look at while they are here.');

    document.getElementById('chart-title').textContent =
      'Visitors per day, last ' + d.days + ' days';
    renderChart(d.daily);

    var sources = document.querySelector('#sources-table tbody');
    if (!d.sources.length) {
      sources.innerHTML = '<tr><td colspan="3" class="admin-table__empty">Nothing recorded yet.</td></tr>';
    } else {
      sources.innerHTML = d.sources.map(function (s) {
        var name = s.source === 'direct' ? 'Typed in or bookmarked' : s.source;
        return '<tr><td>' + esc(name) + '</td><td>' + s.visitors + '</td><td>' + s.views + '</td></tr>';
      }).join('');
    }

    document.querySelector('#daily-table tbody').innerHTML = d.daily
      .slice()
      .reverse()
      .map(function (r) {
        return '<tr><td>' + esc(shortDate(r.day)) + '</td><td>' + r.visitors + '</td><td>' + r.views + '</td></tr>';
      }).join('');
  }

  async function loadStats() {
    try {
      statsData = await api('/stats?days=' + statsRange);
      renderStats();
    } catch (err) {
      document.getElementById('chart').innerHTML =
        '<p class="admin-empty">' + esc(err.message) + '</p>';
    }
  }

  document.querySelectorAll('[data-range]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('[data-range]').forEach(function (b) {
        b.removeAttribute('aria-pressed');
      });
      btn.setAttribute('aria-pressed', 'true');
      statsRange = Number(btn.getAttribute('data-range'));
      loadStats();
    });
  });

  /* ---------------------------------------------------------------- tabs */

  document.querySelectorAll('.admin-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.admin-tab').forEach(function (t) {
        t.removeAttribute('aria-current');
      });
      tab.setAttribute('aria-current', 'page');
      var name = tab.getAttribute('data-tab');
      document.querySelectorAll('.admin-panel').forEach(function (panel) {
        panel.classList.toggle('is-active', panel.id === 'panel-' + name);
      });
      // Visitor figures are fetched when the tab is opened, and refreshed on
      // each visit so they are never stale.
      if (name === 'visitors') loadStats();
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
