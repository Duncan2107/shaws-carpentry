#!/usr/bin/env python3
"""Generate db/seed.sql from the current HTML pages.

The site's content started life hand-written in HTML. Rather than retyping it
into the database (and risking losing or altering a line), this reads the
pages and writes the equivalent INSERT statements.

Run from the repo root:  python db/extract-seed.py
"""

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, 'public')
OUT = os.path.join(ROOT, 'db', 'seed.sql')


def read(name):
    with io.open(os.path.join(PUBLIC, name), encoding='utf-8') as f:
        return f.read()


def sql(value):
    """Quote a value for SQLite."""
    if value is None:
        return 'NULL'
    return "'" + str(value).replace("'", "''") + "'"


def clean(text):
    """Collapse whitespace and decode the few entities we actually use."""
    text = re.sub(r'\s+', ' ', text).strip()
    for entity, char in (('&amp;', '&'), ('&nbsp;', ' '), ('&lt;', '<'), ('&gt;', '>')):
        text = text.replace(entity, char)
    return text


CARD_RE = re.compile(
    r'<article class="card([^"]*)"[^>]*>\s*'
    r'(?:<div class="card__media"><img src="([^"]+)" alt="([^"]*)"[^>]*></div>\s*)?'
    r'<div class="card__body"[^>]*>\s*'
    r'<h3>(.*?)</h3>\s*'
    r'<p>(.*?)</p>',
    re.S,
)

GALLERY_RE = re.compile(
    r'<figure class="gallery-item[^"]*"[^>]*>\s*'
    r'<img src="([^"]+)" alt="([^"]*)"[^>]*>\s*'
    r'<figcaption>(.*?)</figcaption>',
    re.S,
)


def extract_services():
    """Service cards, split by the two grids on the services page.

    The 'Something Else in Mind?' cards are deliberately skipped: they are
    fixed page furniture, not services Stuart should be able to delete.
    """
    html = read('services.html')
    grids = html.split('<!-- Commercial services -->')
    if len(grids) != 2:
        sys.exit('services.html layout changed: expected a commercial services marker')

    rows = []
    for category, chunk in (('domestic', grids[0]), ('commercial', grids[1])):
        order = 0
        for classes, src, alt, title, desc in CARD_RE.findall(chunk):
            if 'card--enquire' in classes:
                continue
            order += 1
            rows.append({
                'category': category,
                'title': clean(title),
                'description': clean(desc),
                'image_key': src,
                'image_alt': clean(alt),
                'sort_order': order,
            })
    return rows


# Which services start out on the home page grid.
#
# The hand-written home page used combined marketing titles ("Fitted Kitchens
# & Bathrooms") that do not map to a single service row, so the four below are
# a deliberate stand-in covering the same spread of work. Stuart can change the
# selection from /admin without touching this file.
FEATURED_TITLES = [
    'Fitted Kitchens',
    'Fitted Wardrobes',
    'Doors',
    'Garden Decking',
]


def extract_gallery():
    html = read('gallery.html')
    rows = []
    for order, (src, alt, caption) in enumerate(GALLERY_RE.findall(html), start=1):
        rows.append({
            'caption': clean(caption),
            'image_key': src,
            'image_alt': clean(alt),
            'sort_order': order,
        })
    return rows


def extract_settings():
    html = read('contact.html')

    def grab(pattern, label):
        m = re.search(pattern, html, re.S)
        if not m:
            sys.exit('could not find %s in contact.html' % label)
        return m

    phone_href = grab(r'href="tel:([^"]+)"', 'phone link').group(1)
    phone_text = grab(r'href="tel:[^"]+">([^<]+)</a>', 'phone text').group(1)
    email = grab(r'href="mailto:([^"]+)"', 'email').group(1)

    area_block = grab(
        r'<h3>Service Area</h3>\s*<p>(.*?)</p>', 'service area').group(1)
    areas = [clean(part) for part in area_block.split('<br>')]

    hours_block = grab(r'<h3>Hours</h3>\s*<p>(.*?)</p>', 'hours').group(1)
    hours = [clean(part) for part in hours_block.split('<br>')]

    form_endpoint = grab(r'data-endpoint="([^"]+)"', 'form endpoint').group(1)

    # The footer uses a shorter form of the same areas.
    footer = grab(r'<ul data-content="footer-contact">(.*?)</ul>', 'footer contact list').group(1)
    footer_areas = re.findall(r'<li>((?:Domestic|Commercial):[^<]*)</li>', footer)

    return {
        'phone_href': phone_href,
        'phone_display': clean(phone_text),
        'email': email,
        'areas_domestic': areas[0] if areas else '',
        'areas_commercial': areas[1] if len(areas) > 1 else '',
        'areas_domestic_short': clean(footer_areas[0]) if footer_areas else '',
        'areas_commercial_short': clean(footer_areas[1]) if len(footer_areas) > 1 else '',
        'hours_weekday': hours[0] if hours else '',
        'hours_weekend': hours[1] if len(hours) > 1 else '',
        'form_endpoint': form_endpoint,
    }


def main():
    services = extract_services()
    gallery = extract_gallery()
    settings = extract_settings()

    if not services:
        sys.exit('no services extracted, refusing to write an empty seed')
    if not gallery:
        sys.exit('no gallery items extracted, refusing to write an empty seed')

    titles = set(s['title'] for s in services)
    missing = [t for t in FEATURED_TITLES if t not in titles]
    if missing:
        sys.exit('featured titles not found among services: %s' % ', '.join(missing))

    def is_featured(title):
        return title in FEATURED_TITLES

    lines = [
        '-- Generated by db/extract-seed.py from the HTML pages. Do not edit by hand.',
        '-- Regenerate with: python db/extract-seed.py',
        '',
        'DELETE FROM services;',
        'DELETE FROM gallery;',
        'DELETE FROM testimonials;',
        'DELETE FROM settings;',
        '',
    ]

    lines.append('-- Services (%d domestic, %d commercial)' % (
        sum(1 for s in services if s['category'] == 'domestic'),
        sum(1 for s in services if s['category'] == 'commercial'),
    ))
    for s in services:
        lines.append(
            'INSERT INTO services '
            '(category, title, description, image_key, image_alt, show_on_home, show_on_services, sort_order) VALUES '
            '(%s, %s, %s, %s, %s, %d, 1, %d);' % (
                sql(s['category']), sql(s['title']), sql(s['description']),
                sql(s['image_key']), sql(s['image_alt']),
                1 if is_featured(s['title']) else 0, s['sort_order'],
            )
        )

    lines.append('')
    lines.append('-- Gallery: %d projects, each starting with a single photo.' % len(gallery))
    lines.append('-- More photos can be added to any project from /admin, and the')
    lines.append('-- website then steps through them in a carousel.')
    for g in gallery:
        lines.append(
            'INSERT INTO gallery (caption, sort_order) VALUES (%s, %d);'
            % (sql(g['caption']), g['sort_order'])
        )
        lines.append(
            'INSERT INTO gallery_images (gallery_id, image_key, image_alt, sort_order) VALUES '
            '(last_insert_rowid(), %s, %s, 1);'
            % (sql(g['image_key']), sql(g['image_alt']))
        )

    lines.append('')
    lines.append('-- Contact settings')
    for key in sorted(settings):
        lines.append('INSERT INTO settings (key, value) VALUES (%s, %s);'
                     % (sql(key), sql(settings[key])))

    lines.append('')
    lines.append('-- No testimonials yet: the home page keeps showing the')
    lines.append('-- "Reviews coming soon" card until the first one is published.')
    lines.append('')

    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))

    print('wrote %s' % os.path.relpath(OUT, ROOT))
    print('  services:     %d (%d featured)' % (
        len(services), sum(1 for s in services if is_featured(s['title']))))
    print('  gallery:      %d' % len(gallery))
    print('  settings:     %d' % len(settings))


if __name__ == '__main__':
    main()
