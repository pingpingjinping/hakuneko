const fs = require('fs');
const path = require('path');

const moduleRoot = path.join(__dirname, '..', 'mjs');

function readModule(file) {
    return fs.readFileSync(path.join(moduleRoot, file), 'utf8')
        .replace(/^import .*;\s*$/gm, '');
}

function loadMangaDex() {
    const source = readModule('connectors/MangaDex.mjs')
        .replace('export default class MangaDex extends Connector', 'class MangaDex extends Connector');
    class TestConnector {
        constructor() {
            this.requestOptions = { headers: { set() {} } };
        }
        wait() {
            return Promise.resolve();
        }
    }
    class TestRequest {
        constructor(url) {
            this.url = String(url);
        }
    }
    return new Function('Connector', 'Manga', 'Request', 'URL',
        source + '\nreturn MangaDex;')(TestConnector, class {}, TestRequest, URL);
}

function loadManga() {
    const source = readModule('engine/Manga.mjs')
        .replace('export default class Manga extends EventTarget', 'class Manga extends EventTarget');
    return new Function('Chapter', 'EventTarget',
        source + '\nreturn Manga;')(class {}, EventTarget);
}

function loadBookmarkUpdateManager() {
    const source = readModule('engine/BookmarkUpdateManager.mjs')
        .replace('export default class BookmarkUpdateManager extends EventTarget',
            'class BookmarkUpdateManager extends EventTarget');
    class TestEventTarget {
        addEventListener() {}
        dispatchEvent() {}
    }
    class TestCustomEvent {
        constructor(type, init) {
            this.type = type;
            this.detail = init.detail;
        }
    }
    return new Function('Manga', 'EventTarget', 'CustomEvent',
        source + '\nreturn BookmarkUpdateManager;')(
        class {}, TestEventTarget, TestCustomEvent);
}

describe('MangaDex PoW protection and chapter failure recovery', () => {
    const MangaDex = loadMangaDex();

    test('recognizes MangaDex PoW intermediate pages', () => {
        const source = readModule('engine/Request.mjs');
        expect(source).toContain("location.hostname === 'mangadex.org'");
        expect(source).toContain("document.querySelector('div#results-inprogress')");
        expect(source).toMatch(/div#results-inprogress[\s\S]*?handleAutomaticRedirect\(\)/);
    });

    test('an empty valid API feed means zero chapters, not an API error', async () => {
        const connector = new MangaDex();
        connector.fetchJSON = jest.fn().mockResolvedValue({ data: [] });
        await expect(connector._getChaptersFromPage({ id: 'test' }, 0)).resolves.toEqual([]);
    });

    test('a malformed API feed fails instead of reporting zero chapters', async () => {
        const connector = new MangaDex();
        connector.fetchJSON = jest.fn().mockResolvedValue({ status: 'ok' });
        await expect(connector._getChaptersFromPage({ id: 'test' }, 0))
            .rejects.toThrow('invalid chapter list');
    });

    test('403 and HTML challenge responses identify a possible bot block', async () => {
        const connector = new MangaDex();
        connector.fetchJSON = jest.fn()
            .mockRejectedValueOnce(new Error('Failed (status: 403)'))
            .mockRejectedValueOnce(new SyntaxError('Unexpected token <'));
        await expect(connector._getChaptersFromPage({ id: 'test' }, 0))
            .rejects.toThrow('Cloudflare/PoW');
        await expect(connector._getChaptersFromPage({ id: 'test' }, 0))
            .rejects.toThrow('Cloudflare/PoW');
    });

    test('valid chapters still retain their ID, title and language', async () => {
        const connector = new MangaDex();
        connector.fetchJSON = jest.fn().mockResolvedValue({
            data: [{
                id: 'chapter-id',
                attributes: { chapter: '1', translatedLanguage: 'ko', title: 'Test' },
                relationships: []
            }]
        });
        const chapters = await connector._getChaptersFromPage({ id: 'manga-id' }, 0);
        expect(chapters).toEqual([{
            id: 'chapter-id', title: 'Ch.0001 - Test (ko)', language: 'ko'
        }]);
    });

    test('MangaDex errors propagate, but other connectors retain their fallback', async () => {
        const Manga = loadManga();
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const connector = id => ({
                id,
                initialize: () => Promise.resolve(),
                _getChapterList: (manga, callback) => callback(new Error('blocked'), undefined)
            });
            const md = new Manga(connector('mangadex'), 'test', 'Test', 'available');
            await expect(md._getUpdatedChaptersFromWebsite()).rejects.toThrow('blocked');
            const other = new Manga(connector('another'), 'test', 'Test', 'available');
            await expect(other._getUpdatedChaptersFromWebsite()).resolves.toEqual([]);
        } finally {
            warning.mockRestore();
        }
    });

    test('failed scans preserve downloaded IDs but become retryable', async () => {
        const BookmarkUpdateManager = loadBookmarkUpdateManager();
        const bookmark = {
            key: { connector: 'mangadex', manga: 'test' },
            title: { connector: 'MangaDex', manga: 'Test' }
        };
        const previous = {
            chapterIDs: ['chapter'],
            downloadedChapterIDs: ['chapter'],
            checkedAt: new Date().toISOString()
        };
        const state = { version: 1, bookmarks: { '["mangadex","test"]': previous } };
        const settings = {};
        const bookmarkManager = { bookmarks: [bookmark] };
        const downloadManager = { addEventListener() {} };
        const storage = { saveConfig: jest.fn().mockResolvedValue() };
        const manager = new BookmarkUpdateManager(
            settings, bookmarkManager, downloadManager, storage);
        manager._loadState = jest.fn().mockResolvedValue(state);
        manager._checkBookmark = jest.fn().mockRejectedValue(new Error('blocked'));
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const result = await manager.checkForUpdates({ force: true });
            expect(result.failed).toBe(1);
            expect(previous.checkedAt).toBeNull();
            expect(previous.chapterIDs).toEqual(['chapter']);
            expect(previous.downloadedChapterIDs).toEqual(['chapter']);
            expect(storage.saveConfig).toHaveBeenCalledTimes(1);
        } finally {
            warning.mockRestore();
        }
    });
});
