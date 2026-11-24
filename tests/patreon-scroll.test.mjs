import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {chromium} from 'playwright-core';

const extension = fileURLToPath(new URL('../', import.meta.url));

// Both pages load more cards only in response to a real scroll. The second
// card has a compact header instead of the original article markup.
for (const nested of [false, true]) {
    test(`Patreon count grows during ${nested ? 'feed panel' : 'document'} scrolling`, async () => {
        const context = await chromium.launchPersistentContext('', {
            channel: 'chromium',
            executablePath: process.env.CHROMIUM_PATH,
            headless: true,
            ignoreDefaultArgs: ['--disable-extensions'],
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        });
        try {
            const page = context.pages()[0];
            await page.goto('chrome://extensions');
            const id = await page.evaluate(async () => (await chrome.developerPrivate.getExtensionsInfo()).find(info => info.name === 'listr').id);
            const feed = 'https://www.patreon.com/c/example/posts';
            await context.route(feed, route => route.fulfill({contentType: 'text/html', body: `
                <style>body {margin: 0} article {min-height: 150vh} ${nested ? '#panel {overflow-y:auto; height:60vh}' : ''}</style>
                <aside><a href="/posts/sidebar-999">Unrelated</a></aside>
                <div id="panel"><main data-tag="cw-post-stream-container"><article><a href="/posts/first-101">First post</a><button>Load more</button></article></main></div>`}));
            const reads = [];
            await context.route('**/api/posts/*', route => {
                const post = new URL(route.request().url()).pathname.split('/').pop();
                reads.push(post);
                if (post === '101') {
                    return route.fulfill({status: 503, body: 'Temporary error'});
                }
                return route.fulfill({json: {data: {id: post, attributes: {
                    current_user_can_view: true,
                    content: '<a href="https://example.org/attachment">Download</a>',
                }}}});
            });
            await page.goto(feed);
            await page.evaluate(nested => {
                const main = document.querySelector('main');
                main.querySelector('article button').onclick = () => { throw new Error('Clicked a post control'); };
                const scroller = nested ? document.querySelector('#panel') : document;
                scroller.addEventListener('scroll', () => {
                    main.insertAdjacentHTML('beforeend', '<div role="listitem"><header><a href="/posts/second-102">Second post</a></header><img src="data:," data-src="https://cdn.example.org/preview.jpg"></div>');
                    const more = document.createElement('button');
                    more.textContent = 'Load more';
                    main.append(more);
                    more.onclick = () => {
                        if (more.dataset.clicked) {
                            throw new Error('Requested the same page twice');
                        }
                        more.dataset.clicked = 'true';
                        setTimeout(() => {
                            more.remove();
                            main.insertAdjacentHTML('beforeend', '<a href="/posts/third-103">Third post</a>');
                        }, 4500);
                    };
                }, {once: true});
            }, nested);

            const popup = await context.newPage();
            await page.bringToFront();
            await popup.goto(`chrome-extension://${id}/popup.html`);
            await popup.evaluate(() => chrome.storage.local.set({scrollWaitTime: 0}));
            await popup.reload();
            const pageErrors = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await popup.locator('#popup-collect-patreon').click();
            const count = popup.locator('[id^="popup-collection-patreon-"][id$="-count"]');
            await count.waitFor();
            await popup.waitForFunction(() => {
                const count = document.querySelector('[id^="popup-collection-patreon-"][id$="-count"]');
                return count?.textContent === '4' && document.getElementById('popup-toggle-capture');
            }, undefined, {timeout: 12000});
            await popup.waitForFunction(() => document.querySelector('[id^="popup-collection-patreon-"][id$="-count"]')?.textContent === '5');
            assert.deepEqual(pageErrors, []);
            assert.ok(reads.includes('102'));
            assert.ok(!reads.includes('999'));
            const items = await popup.evaluate(async () => {
                const {allCollections} = await chrome.storage.local.get('allCollections');
                return Object.values(allCollections.collections.patreon).flat();
            });
            assert.deepEqual(items.map(item => [item.url, item.mediaType]).sort(), [
                ['https://www.patreon.com/posts/first-101', 'link'],
                ['https://www.patreon.com/posts/second-102', 'link'],
                ['https://www.patreon.com/posts/third-103', 'link'],
                ['https://cdn.example.org/preview.jpg', 'pictures'],
                ['https://example.org/attachment', 'link'],
            ].sort());
        } finally {
            await context.close();
        }
    });
}

test('collection grid exports one full-post job per card and excludes comments and teasers', async () => {
    const context = await chromium.launchPersistentContext('', {
        channel: 'chromium', executablePath: process.env.CHROMIUM_PATH, headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    try {
        const page = context.pages()[0];
        await page.goto('chrome://extensions');
        const id = await page.evaluate(async () => (await chrome.developerPrivate.getExtensionsInfo()).find(info => info.name === 'listr').id);
        const collection = 'https://www.patreon.com/collection/77';
        const posts = ['101', '102'];
        const cards = posts.map(id => `<a href="/posts/${id}?collection=77"><picture><img src="data:," data-src="/preview/${id}.gif"></picture><div data-tag="teaser-post-content">See https://example.org/teaser</div></a>`).join('');
        await context.route(collection, route => route.fulfill({contentType: 'text/html', body: `<main><div data-cardlayout-edgeless="true">${cards}</div><a href="/posts/titled-101">Duplicate</a><div data-tag="comments"><a href="/posts/999">Comment</a></div></main>`}));
        await page.goto(collection);
        const popup = await context.newPage();
        await popup.addInitScript(() => {
            if (globalThis.chrome?.downloads) {
                chrome.downloads.download = ({url}, callback) => {
                    fetch(url).then(response => response.text()).then(csv => {
                        window.exportedCsv = csv;
                        callback(1);
                    });
                };
            }
        });
        await page.bringToFront();
        await popup.goto(`chrome-extension://${id}/popup.html`);
        await popup.locator('#popup-collect-patreon').click();
        await popup.waitForFunction(() => document.querySelector('[id$="-count"]')?.textContent === '2');
        const saved = await popup.evaluate(async () => (await chrome.storage.local.get('allCollections')).allCollections.collections.patreon['Collection 77']);
        const urls = posts.map(id => `https://www.patreon.com/posts/${id}?collection=77`);
        assert.deepEqual(saved.map(item => [item.url, item.mediaType]), urls.map(url => [url, 'link']));
        await popup.locator('#popup-export-all').click();
        await popup.waitForFunction(() => window.exportedCsv);
        assert.deepEqual((await popup.evaluate(() => window.exportedCsv)).split('\n'), [
            'Platform,Type,Handle,Media,link', ...urls.map(url => `patreon,collection,Collection 77,link,${url}`),
        ]);
    } finally {
        await context.close();
    }
});
