# listr

## Patreon collections

Open a Patreon post, creator feed, or collection and click **Collect Patreon images, videos, and links** in the popup. Keep the popup open while it scrolls. You can pause or stop at any time. Listr saves items as it finds them and reads available post details for galleries and attachments.

On a Patreon collection listing, each card contributes one post URL. ClipDownloader opens the full post when you queue it. The count on this page is the number of distinct posts, and the grid’s teaser images are omitted. Saved collections and exports use the cover title followed by the numeric ID, for example `Cop Girl (77)`. Recapturing an older collection fills in its title and creator. CSV exports include an optional Creator column, which ClipDownloader uses to group collections under the creator’s profile.

Export a saved collection as CSV to import it into ClipDownloader. CSV and JSON exports preserve each item’s media type (`pictures`, `video`, or `link`). Some media URLs expire and may require a fresh capture.

## Develop / Build

```bash
npm install
npm run start   # dev watch
npm run build   # prod build (development endpoint)
npm run build:test
npm run build:prod
```

To run the Patreon scrolling regression tests, install Chromium once with `npx playwright-core install --no-shell chromium`, then run `npm run test:patreon`. You can also set `CHROMIUM_PATH` to an existing Chromium executable.

## Load unpacked in Chrome

1. Run `npm run build` to generate `dist/`.
2. Open `chrome://extensions`.
3. Enable Developer mode (top right).
4. Click "Load unpacked" and select this folder.
5. The popup loads from `popup.html`, scripts from `dist/`.

## Package for Chrome Web Store

You need a ZIP of the extension directory (no `node_modules`, sources compiled to `dist/`). Use the script below:

```bash
# Default: production endpoint
./scripts/package.sh

# Or choose env explicitly: development | test | production
./scripts/package.sh production
```

This creates `release/<name>-<version>-<env>.zip` ready for upload.

## Publish to Chrome Web Store

1. Create a developer account at the Chrome Web Store Developer Dashboard.
2. Click "New Item" and upload the ZIP from the `release/` folder.
3. Fill in listing details, privacy, and permissions justification.
4. Submit for review.

## Permissions
- "tabs", "storage"
- Host permissions: `<all_urls>`

## Notes
- Popup UI and content script are ported from the Firefox example.
- `ENDPOINT` is injected via Webpack DefinePlugin from the `ENDPOINT` environment variable (optional). If not set, it defaults to an empty string.
- Uses Tailwind via PostCSS at build time; styles are injected by style-loader.
