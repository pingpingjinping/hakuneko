import Manga from './Manga.mjs';

const stateKey = 'bookmark-update-state';
const stateVersion = 1;
const refreshInterval = 12 * 60 * 60 * 1000;

const languageGroups = {
    ko: {
        label: '한국어',
        codes: ['ko', 'kr', 'kor', 'ko-kr'],
        words: ['korean', '한국', '조선', '🇰🇷']
    },
    en: {
        label: 'English',
        codes: ['en', 'eng', 'en-us', 'en-gb'],
        words: ['english', '🇬🇧', '🇺🇸']
    },
    ja: {
        label: '日本語',
        codes: ['ja', 'jp', 'jpn', 'ja-jp'],
        words: ['japanese', '日本語', '日本', '🇯🇵']
    },
    zh: {
        label: '中文',
        codes: ['zh', 'zho', 'chi', 'zh-cn', 'zh-tw', 'zh-hk'],
        words: ['chinese', '中文', '简体', '簡體', '繁體', '繁体', '汉语', '漢語', '🇨🇳', '🇹🇼', '🇭🇰']
    },
    es: {
        label: 'Español',
        codes: ['es', 'spa', 'es-es', 'es-la', 'es-mx'],
        words: ['spanish', 'español', 'espanol', '🇪🇸']
    },
    fr: {
        label: 'Français',
        codes: ['fr', 'fra', 'fre', 'fr-fr'],
        words: ['french', 'français', 'francais', '🇫🇷']
    },
    de: {
        label: 'Deutsch',
        codes: ['de', 'deu', 'ger', 'de-de'],
        words: ['german', 'deutsch', '🇩🇪']
    },
    it: {
        label: 'Italiano',
        codes: ['it', 'ita', 'it-it'],
        words: ['italian', 'italiano', '🇮🇹']
    },
    pt: {
        label: 'Português',
        codes: ['pt', 'por', 'pt-br', 'pt-pt'],
        words: ['portuguese', 'português', 'portugues', '🇵🇹', '🇧🇷']
    },
    ru: {
        label: 'Русский',
        codes: ['ru', 'rus', 'ru-ru'],
        words: ['russian', 'русский', '🇷🇺']
    },
    vi: {
        label: 'Tiếng Việt',
        codes: ['vi', 'vie', 'vietnamese'],
        words: ['vietnamese', 'tiếng việt', 'tieng viet', '🇻🇳']
    },
    id: {
        label: 'Bahasa Indonesia',
        codes: ['id', 'ind', 'id-id'],
        words: ['indonesian', 'bahasa indonesia', '🇮🇩']
    },
    th: {
        label: 'ไทย',
        codes: ['th', 'tha', 'th-th'],
        words: ['thai', 'ไทย', '🇹🇭']
    }
};

export default class BookmarkUpdateManager extends EventTarget {

    constructor(settings, bookmarkManager, downloadManager, storage) {
        super();
        this._settings = settings;
        this._bookmarkManager = bookmarkManager;
        this._downloadManager = downloadManager;
        this._storage = storage;
        this._running = false;
        this._activeState = null;
        this._historySave = Promise.resolve();
        this._autoDownloadStates = {};

        this._downloadManager.addEventListener('updated', event => {
            let job = event.detail;
            if(!job || !job.chapter) {
                return;
            }

            let downloadKey = this._chapterKey(job.chapter);
            let item = this._autoDownloadStates[downloadKey];
            if(item) {
                item.status = job.status;
                this._dispatchDownloadStatus();
            }

            if(job.status === 'completed') {
                this._rememberDownloadedChapter(job.chapter)
                    .catch(error => console.warn('Failed to remember downloaded bookmark chapter:', error));
            }
        });
    }

    get isRunning() {
        return this._running;
    }

    async checkForUpdates(options = {}) {
        if(this._running) {
            return this._emptyResult();
        }

        this._running = true;
        let languageCode = this._getTargetLanguageCode();
        let languageLabel = this._getLanguageLabel(languageCode);
        let result = this._emptyResult(languageCode, languageLabel);
        let force = !!(options && options.force);
        let parallelChecks = this._getParallelChecks();

        try {
            let state = await this._loadState();
            this._activeState = state;
            let bookmarks = Array.from(this._bookmarkManager.bookmarks || []);
            let processed = 0;
            let nextIndex = 0;

            this.dispatchEvent(new CustomEvent('started', {
                detail: {
                    total: bookmarks.length,
                    force: force,
                    parallel: parallelChecks,
                    refreshHours: 12,
                    languageCode: languageCode,
                    languageLabel: languageLabel,
                    result: Object.assign({}, result)
                }
            }));

            let processBookmark = async bookmark => {
                let skipped = false;
                let key = this._bookmarkKey(bookmark);
                let previous = state.bookmarks[key];

                if(!force && this._isFresh(previous)) {
                    result.skipped++;
                    skipped = true;
                } else {
                    try {
                        let update = await this._checkBookmark(bookmark, state, languageCode);
                        result.checked++;
                        if(update.newChapterCount > 0) {
                            result.updated++;
                        }
                        result.online += update.onlineChapterCount;
                        result.targetTotal += update.targetLanguageTotalCount;
                        result.targetMissing += update.targetLanguageMissingCount;
                        // Keep old fields for compatibility with older status UI builds.
                        result.koreanTotal = result.targetTotal;
                        result.korean = result.targetMissing;
                        result.queued += update.queuedCount;
                    } catch(error) {
                        result.failed++;
                        console.warn('Failed to check bookmark for updates:', bookmark, error);
                    }
                }

                processed++;
                this.dispatchEvent(new CustomEvent('progress', {
                    detail: {
                        current: processed,
                        total: bookmarks.length,
                        skipped: skipped,
                        title: bookmark.title && bookmark.title.manga ? bookmark.title.manga : '',
                        connector: bookmark.title && bookmark.title.connector ? bookmark.title.connector : '',
                        languageCode: languageCode,
                        languageLabel: languageLabel,
                        result: Object.assign({}, result)
                    }
                }));
            };

            let worker = async () => {
                for(;;) {
                    let index = nextIndex++;
                    if(index >= bookmarks.length) {
                        return;
                    }
                    await processBookmark(bookmarks[index]);
                }
            };

            let workers = [];
            let workerCount = Math.min(parallelChecks, bookmarks.length);
            for(let index = 0; index < workerCount; index++) {
                workers.push(worker());
            }
            await Promise.all(workers);

            await this._storage.saveConfig(stateKey, state, 2);
            this.dispatchEvent(new CustomEvent('finished', {
                detail: Object.assign({}, result, {
                    force: force,
                    parallel: parallelChecks,
                    languageCode: languageCode,
                    languageLabel: languageLabel
                })
            }));
            return result;
        } finally {
            this._activeState = null;
            this._running = false;
        }
    }

    _emptyResult(languageCode, languageLabel) {
        return {
            checked: 0,
            skipped: 0,
            updated: 0,
            online: 0,
            targetTotal: 0,
            targetMissing: 0,
            koreanTotal: 0,
            korean: 0,
            queued: 0,
            failed: 0,
            languageCode: languageCode || this._getTargetLanguageCode(),
            languageLabel: languageLabel || this._getLanguageLabel(this._getTargetLanguageCode())
        };
    }

    _getParallelChecks() {
        let value = Number(this._settings.bookmarkUpdateParallelChecks && this._settings.bookmarkUpdateParallelChecks.value);
        if(Number.isNaN(value)) {
            value = 3;
        }
        return Math.max(1, Math.min(10, Math.round(value)));
    }

    _getTargetLanguageCode() {
        let value = this._settings.bookmarkDownloadLanguage && this._settings.bookmarkDownloadLanguage.value;
        return languageGroups[value] ? value : 'ko';
    }

    _getLanguageLabel(code) {
        return languageGroups[code] ? languageGroups[code].label : code;
    }

    _isFresh(previous) {
        if(!previous || !previous.checkedAt) {
            return false;
        }
        let checkedAt = Date.parse(previous.checkedAt);
        return !Number.isNaN(checkedAt) && Date.now() - checkedAt < refreshInterval;
    }

    async _checkBookmark(bookmark, state, languageCode) {
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
        let downloaded = new Set(previous && Array.isArray(previous.downloadedChapterIDs)
            ? previous.downloadedChapterIDs.map(id => String(id))
            : []);
        let newChapters = previous && Array.isArray(previous.chapterIDs)
            ? onlineChapters.filter(chapter => !known.has(String(chapter.id)))
            : [];

        let targetChapters = onlineChapters.filter(chapter => this._isLanguageChapter(chapter, languageCode));

        // Seed permanent history from matching chapters that currently exist on disk.
        // Once a chapter has been completed, moving it elsewhere later must not trigger a re-download.
        for(let chapter of targetChapters) {
            if(chapter.status === 'completed') {
                downloaded.add(String(chapter.id));
            }
        }

        let missingTargetChapters = targetChapters.filter(chapter => {
            return chapter.status === 'available' && !downloaded.has(String(chapter.id));
        });

        let queuedCount = 0;
        if(this._settings.autoDownloadBookmarkUpdates.value) {
            for(let chapter of missingTargetChapters) {
                let added = this._downloadManager.addDownload(chapter);
                if(added) {
                    queuedCount++;
                    this._autoDownloadStates[this._chapterKey(chapter)] = {
                        status: 'queued',
                        connector: bookmark.title && bookmark.title.connector ? bookmark.title.connector : connector.label,
                        manga: bookmark.title && bookmark.title.manga ? bookmark.title.manga : manga.title,
                        chapter: chapter.title || String(chapter.id)
                    };
                    this._dispatchDownloadStatus();
                }
            }
        }

        state.bookmarks[key] = {
            connector: bookmark.key.connector,
            manga: bookmark.key.manga,
            chapterIDs: currentIDs,
            downloadedChapterIDs: Array.from(downloaded),
            checkedAt: new Date().toISOString()
        };

        return {
            newChapterCount: newChapters.length,
            onlineChapterCount: onlineChapters.length,
            targetLanguageTotalCount: targetChapters.length,
            targetLanguageMissingCount: missingTargetChapters.length,
            queuedCount: queuedCount
        };
    }

    _chapterKey(chapter) {
        let manga = chapter && chapter.manga;
        let connector = manga && manga.connector;
        return JSON.stringify([
            connector ? connector.id : '',
            manga ? manga.id : '',
            chapter ? chapter.id : ''
        ]);
    }

    _getDownloadStatus() {
        let result = {
            queued: 0,
            downloading: 0,
            completed: 0,
            failed: 0,
            total: 0,
            items: []
        };

        for(let key in this._autoDownloadStates) {
            let item = this._autoDownloadStates[key];
            let status = item.status;
            result.total++;
            if(status === 'queued') {
                result.queued++;
            } else if(status === 'downloading') {
                result.downloading++;
            } else if(status === 'completed') {
                result.completed++;
            } else if(status === 'failed') {
                result.failed++;
            }
            result.items.push({
                connector: item.connector || '',
                manga: item.manga || '',
                chapter: item.chapter || '',
                status: status
            });
        }
        return result;
    }

    _dispatchDownloadStatus() {
        this.dispatchEvent(new CustomEvent('download-status', {
            detail: this._getDownloadStatus()
        }));
    }

    async _rememberDownloadedChapter(chapter) {
        let connector = chapter.manga && chapter.manga.connector;
        let manga = chapter.manga;
        if(!connector || !manga) {
            return;
        }

        let apply = state => {
            let key = JSON.stringify([connector.id, manga.id]);
            let previous = state.bookmarks[key] || {};
            let downloaded = new Set(Array.isArray(previous.downloadedChapterIDs)
                ? previous.downloadedChapterIDs.map(id => String(id))
                : []);
            downloaded.add(String(chapter.id));
            state.bookmarks[key] = Object.assign({}, previous, {
                connector: connector.id,
                manga: manga.id,
                downloadedChapterIDs: Array.from(downloaded)
            });
            return state;
        };

        if(this._activeState) {
            apply(this._activeState);
            return;
        }

        this._historySave = this._historySave.then(async () => {
            let state = await this._loadState();
            apply(state);
            await this._storage.saveConfig(stateKey, state, 2);
        });
        await this._historySave;
    }

    _isLanguageChapter(chapter, languageCode) {
        let group = languageGroups[languageCode] || languageGroups.ko;
        let values = this._languageStrings(chapter.language);

        for(let value of values) {
            let normalized = value.trim().toLowerCase().replace(/_/g, '-');
            if(group.codes.indexOf(normalized) >= 0) {
                return true;
            }
            for(let word of group.words) {
                if(normalized.indexOf(word.toLowerCase()) >= 0) {
                    return true;
                }
            }
            for(let code of group.codes) {
                let escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                let regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
                if(regex.test(normalized)) {
                    return true;
                }
            }
        }

        // Some connectors expose no language field. Only accept clearly marked titles in that case.
        if(values.length === 0) {
            let title = String(chapter.title || '').toLowerCase().replace(/_/g, '-');
            for(let word of group.words) {
                if(title.indexOf(word.toLowerCase()) >= 0) {
                    return true;
                }
            }
            for(let code of group.codes) {
                if(title.indexOf(`[${code}]`) >= 0 || title.indexOf(`(${code})`) >= 0) {
                    return true;
                }
            }
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
