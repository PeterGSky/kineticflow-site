# kineticflow.systems website

Static marketing site for KineticFlow, a service from Kinetic Flow Limited (company number 17526373).
No build step: the files in this folder are the site.

| File | What it is |
| --- | --- |
| `index.html` | Home page: features, pricing, FAQ |
| `privacy.html` | Privacy policy, including cookies (`privacy.html#cookies`) |
| `terms.html` | Terms page |
| `data-deletion.html` | How to have data deleted (also used as Meta's data deletion URL) |
| `contact.html` | Contact details and company information |
| `modern-slavery.html` | Voluntary modern slavery statement |
| `404.html` | Page shown for missing pages |
| `site.css` | Shared styles |

## Publish on DigitalOcean App Platform

1. Create → App Platform → GitHub, pick this repository and the `main` branch, Autodeploy on.
2. Static Site: build command empty, output directory `/`, error document `404.html`.
3. In the app's Settings → Domains add `kineticflow.systems` and `www.kineticflow.systems`. DNS is already on DigitalOcean, so the records are created automatically.

Prices on the home page (agreed 20 October 2026): Free; Starter £12 and Team £20 per user a month, or £10 and £17 paid yearly. No VAT until registered.
