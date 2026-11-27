# Relay marketing site

A static, dependency-free landing page for Relay. It lives in its own folder so it can be deployed independently of the CLI.

## Preview locally

```sh
cd site
python3 -m http.server 8000
# open http://localhost:8000
```

Or just open `site/index.html` in a browser. Everything works without a build step.

## Deploy

Publish the contents of `site/` to any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages). No environment variables or build command are required.

For GitHub Pages, set the source to `/main/site` in the repository settings.

## Files

- `index.html` — page structure and copy
- `styles.css` — design system, layout and responsive rules
- `app.js` — copy buttons, screenshot tabs, strategy switcher, segmented-control thumbs, mobile menu, scroll reveals
- `assets/` — desktop app screenshots (taken with demo data)
- `favicon.svg` — brand mark

## Things you may want to change

- **Domain / social preview:** `og:url` and `og:image` in `index.html` currently point at the GitHub repo and raw screenshot. Update them if you use a custom domain.
- **Pricing/licensing:** the page intentionally makes no licensing or price claims. The `#install` section is a neutral "Get Relay" block. Add your plan names, prices and checkout links there when they're ready.
- **Links:** GitHub links point to `plzgimmeaname/relay`; change them if the product moves.
