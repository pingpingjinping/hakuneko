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
            return { checked: 0, updated: 0, queued: 0, failed: 0 };
        }

        this._running = true;
        let result = { checked: 0, updated: 0, queued: 0, failed: 0 };

        try {
            let state = await this._loadState();
            let bookmarks = Array.from(this._bookmarkManager.bookmarks || []);

            // Process bookmarks sequentially. Some connectors rate-limit or internally lock requests,
            // and checking every bookmark in parallel can easily trip those protections.
            for(let bookmark of bookmarks) {
                try {
                    let update = await this._checkBookmark(bookmark, state);
                    result.checked++;
                    if(update.newChapterCount > 0) {
                        result.updated++;
                    }
                    result.queued += update.queuedCount;
                } catch(error) {
                    result.failed++;
                    console.warn('Failed to check bookmark for updates:', bookmark, error);
                }
            }

            await this._storage.saveConfig(stateKey, state, 2);
            console.info(
                `Bookmark update check finished: ${result.checked} checked, ` +
                `${result.updated} updated, ${result.queued} queued, ${result.failed} failed.`
            );
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

        // A Manga object only needs connector/id/title to retrieve its current chapter list.
        // This avoids refreshing the connector's complete manga list just to check a bookmark.
        let manga = new Manga(connector, bookmark.key.manga, bookmark.title.manga);
        let chapters = await this._getChapters(manga);
        let onlineChapters = chapters.filter(chapter => chapter.status !== 'offline');
        let currentIDs = onlineChapters.map(chapter => String(chapter.id));
        let key = this._bookmarkKey(bookmark);
        let previous = state.bookmarks[key];

        // First encounter is deliberately a baseline only. Without this guard, enabling the
        // feature would interpret every historical chapter as new and queue the entire series.
        if(!previous || !Array.isArray(previous.chapterIDs)) {
            state.bookmarks[key] = {
                connector: bookmark.key.connector,
                manga: bookmark.key.manga,
                chapterIDs: currentIDs,
                checkedAt: new Date().toISOString()
            };
            return { newChapterCount: 0, queuedCount: 0 };
        }

        let known = new Set(previous.chapterIDs.map(id => String(id)));
        let newChapters = onlineChapters.filter(chapter => !known.has(String(chapter.id)));
        let queuedCount = 0;

        if(this._settings.autoDownloadBookmarkUpdates.value) {
            for(let chapter of newChapters) {
                // Completed chapters may appear as newly discovered after state recovery/import.
                // Never queue files HakuNeko already sees on disk.
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

        if(newChapters.length > 0) {
            console.info(
                `Bookmark updated: ${bookmark.title.manga} (${bookmark.title.connector}) - ` +
                `${newChapters.length} new chapter(s), ${queuedCount} queued.`
            );
        }

        return { newChapterCount: newChapters.length, queuedCount };
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
            return {
                version: stateVersion,
                bookmarks: {}
            };
        }
    }
}
