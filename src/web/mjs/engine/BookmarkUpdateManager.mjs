import Manga from './Manga.mjs';

const stateKey = 'bookmark-update-state';
const stateVersion = 1;

export default class BookmarkUpdateManager extends EventTarget {

    constructor(settings, bookmarkManager, downloadManager, storage) {
        super();
        this._settings = settings;
        this._bookmarkManager = bookmarkManager;
        this._downloadManager = downloadManager;
        this._storage = storage;
        this._running = false;
    }

    get isRunning() {
        return this._running;
    }

    async checkForUpdates() {
        if(this._running) {
            return { checked: 0, updated: 0, korean: 0, queued: 0, failed: 0 };
        }

        this._running = true;
        let result = { checked: 0, updated: 0, korean: 0, queued: 0, failed: 0 };

        try {
            let state = await this._loadState();
            let bookmarks = Array.from(this._bookmarkManager.bookmarks || []);
            let processed = 0;

            this.dispatchEvent(new CustomEvent('started', {
                detail: { total: bookmarks.length, result: Object.assign({}, result) }
            }));

            for(let bookmark of bookmarks) {
                try {
                    let update = await this._checkBookmark(bookmark, state);
                    result.checked++;
                    if(update.newChapterCount > 0) {
                        result.updated++;
                    }
                    result.korean += update.koreanChapterCount;
                    result.queued += update.queuedCount;
                } catch(error) {
                    result.failed++;
                    console.warn('Failed to check bookmark for updates:', bookmark, error);
                }

                processed++;
                this.dispatchEvent(new CustomEvent('progress', {
                    detail: {
                        current: processed,
                        total: bookmarks.length,
                        title: bookmark.title && bookmark.title.manga ? bookmark.title.manga : '',
                        connector: bookmark.title && bookmark.title.connector ? bookmark.title.connector : '',
                        result: Object.assign({}, result)
                    }
                }));
            }

            await this._storage.saveConfig(stateKey, state, 2);
            this.dispatchEvent(new CustomEvent('finished', { detail: result }));
            return result;
        } finally {
            this._running = false;
        }
    }

    async _checkBookmark(bookmark, state) {
        let connector = Engine.Connectors.find(connector => connector.id === bookmark.key.connector);
        if(!connector) {
            throw new Error(`Connector not found: ${bookmark.key.connector}`);
        }

        let manga = new Manga(connector, bookmark.key.manga, bookmark.title.manga);
        let chapters = await this._getChapters(manga);
        let onlineChapters = chapters.filter(chapter => chapter.status !== 'offline');

        if(onlineChapters.length === 0) {
            throw new Error('No online chapters returned; update state was left unchanged.');
        }

        let currentIDs = onlineChapters.map(chapter => String(chapter.id));
        let key = this._bookmarkKey(bookmark);
        let previous = state.bookmarks[key];

        if(!previous || !Array.isArray(previous.chapterIDs)) {
            state.bookmarks[key] = {
                connector: bookmark.key.connector,
                manga: bookmark.key.manga,
                chapterIDs: currentIDs,
                checkedAt: new Date().toISOString()
            };
            return { newChapterCount: 0, koreanChapterCount: 0, queuedCount: 0 };
        }

        let known = new Set(previous.chapterIDs.map(id => String(id)));
        let newChapters = onlineChapters.filter(chapter => !known.has(String(chapter.id)));
        let koreanChapters = newChapters.filter(chapter => this._isKoreanChapter(chapter));
        let queuedCount = 0;

        if(this._settings.autoDownloadBookmarkUpdates.value) {
            for(let chapter of koreanChapters) {
                if(chapter.status === 'available') {
                    this._downloadManager.addDownload(chapter);
                    queuedCount++;
                }
            }
        }

        state.bookmarks[key] = {
            connector: bookmark.key.connector,
            manga: bookmark.key.manga,
            chapterIDs: currentIDs,
            checkedAt: new Date().toISOString()
        };

        return {
            newChapterCount: newChapters.length,
            koreanChapterCount: koreanChapters.length,
            queuedCount: queuedCount
        };
    }

    _isKoreanChapter(chapter) {
        let language = chapter.language;
        let value = '';

        if(typeof language === 'string' || typeof language === 'number') {
            value = String(language).trim().toLowerCase();
        } else if(language) {
            for(let property of ['code', 'id', 'name', 'label', 'language']) {
                if(language[property] !== undefined && language[property] !== null) {
                    value = String(language[property]).trim().toLowerCase();
                    break;
                }
            }
        }

        if(['ko', 'kr', 'kor', 'ko-kr', 'korean', '한국어', '한국'].includes(value)) {
            return true;
        }

        if(value) {
            return false;
        }

        let title = String(chapter.title || '').toLowerCase();
        return title.includes('[kr]') || title.includes('[kor]') || title.includes('[korean]') ||
            title.includes('[한국어]') || title.includes('(kr)') || title.includes('(korean)') ||
            title.includes('(한국어)');
    }

    _getChapters(manga) {
        return new Promise((resolve, reject) => {
            manga.getChapters((error, chapters) => {
                if(error) {
                    reject(error);
                } else {
                    resolve(chapters || []);
                }
            });
        });
    }

    _bookmarkKey(bookmark) {
        return JSON.stringify([bookmark.key.connector, bookmark.key.manga]);
    }

    async _loadState() {
        try {
            let state = await this._storage.loadConfig(stateKey);
            if(!state || state.version !== stateVersion || !(state.bookmarks instanceof Object)) {
                throw new Error('Invalid bookmark update state');
            }
            return state;
        } catch(error) {
            return { version: stateVersion, bookmarks: {} };
        }
    }
}
