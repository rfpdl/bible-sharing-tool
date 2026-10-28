# Bible Sharing Tool

Prepare a list of Bible passages, add notes, and step through them while reading together.

**▶ Use it: [bible.poncethelion.com](https://bible.poncethelion.com)**: works in any browser, installable on your phone, no account needed.

Static PWA: no backend, studies are saved in the browser's localStorage, share links carry the whole study in the URL.

- Verse text: KJV / WEB / WEBBE (public domain) from bible-api.com, cached on the device after first view
- Other translations (NIV, ESV, NASB…): "Open in" button links to Bible.com

<p align="center">
  <img src="docs/home.png" width="200" alt="Home: your studies">
  <img src="docs/editor.png" width="200" alt="Editor: passages, readers and notes">
  <img src="docs/present-dark.png" width="200" alt="Reading a passage (dark)">
  <img src="docs/present-light.png" width="200" alt="Reading a passage (light)">
</p>

## Files

```
public/          ← everything that gets deployed
  index.html     the whole app
  sw.js          offline cache (bump VERSION when shipping changes)
  _headers       Cloudflare headers: security, caching, noindex
wrangler.toml    Cloudflare Workers config (static assets from public/)
```

## Run locally

```sh
npx wrangler dev              # http://localhost:8787
```

## Deploy to Cloudflare

Connected to GitHub: Cloudflare dashboard → Workers & Pages → Create → Import a repository → `rfpdl/bible-sharing-tool`.
Leave the build command empty and keep the deploy command `npx wrangler deploy`. Every push to `main` redeploys.

Or from your machine:

```sh
npx wrangler login            # first time only
npx wrangler deploy
```

Production: [bible.poncethelion.com](https://bible.poncethelion.com) (custom domain on the Worker).

## Install on your phone

Open the site, then:
- iPhone: Safari → Share → Add to Home Screen
- Android: Chrome → ⋮ → Install app

## Credits

Fonts: [Inter](https://rsms.me/inter/) and [Newsreader](https://github.com/productiontype/Newsreader), both SIL Open Font License, self-hosted in `public/fonts`.
