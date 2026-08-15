/**
 * Structured data: the description of the business, its services and the
 * page's place in the site, written in the vocabulary search engines read.
 *
 * All of it is built from the database, so it cannot drift away from what the
 * page says. Edit the phone number in the admin and this changes with it.
 *
 * One <script type="application/ld+json"> per page holding a @graph. The
 * business carries a fixed @id and is repeated on every page, which is what
 * tells Google the four pages describe one business rather than four.
 *
 * Two things are deliberately absent, and both are decisions rather than
 * oversights. See the notes on businessNode().
 */

/** Only keep the keys that actually have a value behind them. */
function present(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined && v !== ''));
}

/** A root-relative path from the database, as an absolute URL. */
function absolute(origin, path) {
  if (!path) return undefined;
  return path.startsWith('/') ? origin + path : path;
}

/**
 * The business itself.
 *
 * No postal address. The address in the settings table is there to print on
 * invoices, and publishing where somebody works is their decision to make, not
 * a side effect of an SEO change. A business that travels to its customers is
 * described by the area it covers instead, which is what areaServed is for.
 * If Stuart wants the address public, it is one more key here.
 *
 * No opening hours either. Schema wants them as "Mo-Fr 08:00-18:00" and the
 * settings hold prose that Stuart can edit freely, so anything that parsed it
 * would be one edit away from publishing hours the business does not keep.
 * Wrong structured data is worse than none. The hours are still on the page
 * for a human to read.
 *
 * HomeAndConstructionBusiness rather than GeneralContractor: schema.org has no
 * type for a carpenter, and this one covers domestic and commercial work
 * without claiming to be a main contractor.
 */
function businessNode(content, origin) {
  const s = content.setting;
  const areas = [s.areas_domestic, s.areas_commercial].filter(Boolean);

  return present({
    '@type': 'HomeAndConstructionBusiness',
    '@id': `${origin}/#business`,
    name: s.business_name,
    url: `${origin}/`,
    telephone: s.phone_href,
    email: s.email,
    image: `${origin}/Media/logo.png`,
    logo: `${origin}/Media/logo.png`,
    // Prose, because that is what the settings hold. It gets better on its own
    // once the areas are named as towns rather than counties.
    areaServed: areas.length ? areas : undefined,
  });
}

/**
 * Where this page sits in the site.
 *
 * Two levels today. It earns its keep properly once each service has a page of
 * its own and the trail reads Home, Services, Fitted Kitchens.
 */
const CRUMBS = {
  '/services': 'Services',
  '/gallery': 'Our Work',
  '/contact': 'Contact',
};

function breadcrumbNode(origin, path) {
  const name = CRUMBS[path];
  if (!name) return null; // The home page is the root, so it has no trail.

  return {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
      { '@type': 'ListItem', position: 2, name, item: origin + path },
    ],
  };
}

/**
 * One node per service on the services page, from the same rows that render
 * the cards, so adding a service in the admin adds its markup too.
 *
 * No @id on these. Inventing one from the title would only have to be replaced
 * when services get real slugs of their own.
 */
function serviceNodes(content, origin) {
  return content.services
    .filter((s) => s.show_on_services)
    .map((s) =>
      present({
        '@type': 'Service',
        name: s.title,
        description: s.description,
        serviceType: s.title,
        image: absolute(origin, s.image_key),
        provider: { '@id': `${origin}/#business` },
      })
    );
}

/**
 * Build the graph for one page.
 *
 * The business goes on every page under the same @id. Everything else depends
 * on which page this is.
 */
export function structuredData(content, origin, path) {
  const graph = [businessNode(content, origin)];

  const crumbs = breadcrumbNode(origin, path);
  if (crumbs) graph.push(crumbs);

  if (path === '/services') graph.push(...serviceNodes(content, origin));

  return { '@context': 'https://schema.org', '@graph': graph };
}

/**
 * Writes the graph into the head.
 *
 * Every < is escaped. Without it a description holding "</script>" would end
 * the block early and the rest of the JSON would be parsed as markup.
 */
export class StructuredData {
  constructor(data) {
    this.json = JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
  }

  element(el) {
    el.append(`\n  <script type="application/ld+json">\n${this.json}\n  </script>\n`, {
      html: true,
    });
  }
}
