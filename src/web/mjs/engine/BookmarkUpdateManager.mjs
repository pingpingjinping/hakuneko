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
            return this._emptyResult();
        }

        this._running = true;
        let result = this._emptyResult();

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
                    result.online += update.onlineChapterCount;
                    result.koreanTotal += update.koreanTotalCount;
                    result.korean += update.koreanChapterCount;
                    result.queued += update.queuedCount;
                    for(let value of update.languageValues) {
                        if(result.languages.indexOf(value) < 0 && result.languages.length < 12) {
                            result.languages.push(value);
                        }
                    }
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
                        result: Object.assign({}, result, { languages: result.languages.slice() })
                    }
                }));
            }

            await this._storage.saveConfig(stateKey, state, 2);
            this.dispatchEvent(new CustomEvent('finished', {
                detail: Object.assign({}, result, { languages: result.languages.slice() })
            }));
            return result;
        } finally {
            this._running = false;
        }
    }

    _emptyResult() {
        return {
            checked: 0,
            updated: 0,
            online: 0,
            koreanTotal: 0,
            korean: 0,
            queued: 0,
            failed: 0,
            languages: []
        };
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
        let known = new Set(previous && Array.isArray(previous.chapterIDs) ? previous.chapterIDs.map(id => String(id)) : []);
        let newChapters = previous && Array.isArray(previous.chapterIDs)
            ? onlineChapters.filter(chapter => !known.has(String(chapter.id)))
            : [];

        let koreanChapters = onlineChapters.filter(chapter => this._isKoreanChapter(chapter));
        let missingKoreanChapters = koreanChapters.filter(chapter => chapter.status === 'available');
        let languageValues = [];

        for(let chapter of onlineChapters) {
            let values = this._languageStrings(chapter.language);
            if(values.length === 0) {
                if(languageValues.indexOf('(없음)') < 0) {
                    languageValues.push('(없음)');
                }
            } else {
                for(let value of values) {
                    if(languageValues.indexOf(value) < 0 && languageValues.length < 8) {
                        languageValues.push(value);
                    }
                }
            }
        }

        let queuedCount = 0;
        if(this._settings.autoDownloadBookmarkUpdates.value) {
            for(let chapter of missingKoreanChapters) {
                this._downloadManager.addDownload(chapter);
                queuedCount++;
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
            onlineChapterCount: onlineChapters.length,
            koreanTotalCount: koreanChapters.length,
            koreanChapterCount: missingKoreanChapters.length,
            queuedCount: queuedCount,
            languageValues: languageValues
        };
    }

    _isKoreanChapter(chapter) {
        let values = this._languageStrings(chapter.language);
        for(let value of values) {
            let normalized = value.trim().toLowerCase().replace(/_/g, '-');
            if(normalized.indexOf('🇰🇷') >= 0 || normalized.indexOf('korean') >= 0 || normalized.indexOf('한국') >= 0) {
                return true;
            }
            if(/(^|[^a-z])(ko|kr|kor)([^a-z]|$)/i.test(normalized)) {
                return true;
            }
        }

        // Some connectors do not expose a language value. Keep the fallback conservative so an
        // unlabeled multi-language connector cannot accidentally queue every available chapter.
        if(values.length === 0) {
            let title = String(chapter.title || '').toLowerCase();
            return title.indexOf('🇰🇷') >= 0 || title.indexOf('[kr]') >= 0 ||
                title.indexOf('[kor]') >= 0 || title.indexOf('[korean]') >= 0 ||
                title.indexOf('[한국어]') >= 0 || title.indexOf('(kr)') >= 0 ||
                title.indexOf('(kor)') >= 0 || title.indexOf('(korean)') >= 0 ||
                title.indexOf('(한국어)') >= 0;
        }

        return false;
    }

    _languageStrings(language) {
        let values = [];
        let add = value => {
            if(value === undefined || value === null) {
                return;
            }
            if(Array.isArray(value)) {
                value.forEach(add);
                return;
            }
            if(typeof value === 'object') {
                for(let property of ['code', 'id', 'name', 'label', 'language', 'value', 'title']) {
                    if(value[property] !== undefined && value[property] !== null) {
                        add(value[property]);
                    }
                }
                return;
            }
            let text = String(value).trim();
            if(text && values.indexOf(text) < 0) {
                values.push(text);
            }
        };
        add(language);
        return values;
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
