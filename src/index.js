/**
 * Shaws Carpentry site Worker.
 *
 * Phase 1: every request is served from the static assets in public/.
 * Later phases intercept the HTML pages here to inject content from D1,
 * serve uploaded photos from R2, and host the admin API.
 */

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
