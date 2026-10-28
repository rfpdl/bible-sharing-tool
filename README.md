# Bible Sharing Tool

Prepare a list of Bible passages, add notes, and step through them while reading together.
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
wrangler.toml    Cloudflare Pages project config
```

## Run locally

```sh
npx wrangler pages dev        # http://localhost:8788
```

## Deploy to Cloudflare Pages

```sh
npx wrangler login            # first time only
npx wrangler pages deploy     # creates the "bible-sharing-tool" project on first run
```

The site will be at `https://bible-sharing-tool.pages.dev` (or the name Cloudflare assigns).

## Install on your phone

Open the site, then:
- iPhone: Safari → Share → Add to Home Screen
- Android: Chrome → ⋮ → Install app

## Credits

Fonts: [Inter](https://rsms.me/inter/) and [Newsreader](https://github.com/productiontype/Newsreader), both SIL Open Font License, self-hosted in `public/fonts`.
