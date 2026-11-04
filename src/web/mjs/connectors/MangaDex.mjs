import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class MangaDex extends Connector {

    constructor() {
        super();
        super.id = 'mangadex';
        super.label = 'MangaDex';
        this.tags = [ 'manga', 'high-quality', 'multi-lingual' ];
        this.url = 'https://mangadex.org';
        this.api = 'https://api.mangadex.org';
        this.requestOptions.headers.set('x-referer', this.url);
        // Do not send fake Chromium client hints that disagree with this old Electron runtime.
        this.config = {
            throttleRequests: {
                label: 'Throttle API Requests [ms]',
                description: 'Enter the timespan in [ms] to delay consecuitive requests to the api.',
                input: 'numeric',
                min: 100,
                max: 10000,
                value: 2000
            },
            throttle: {
                label: 'Throttle Image Requests [ms]',
                description: 'Enter the timespan in [ms] to delay consecuitive HTTP requests.\nThe website may block images for to many consecuitive requests.',
                input: 'numeric',
                min: 50,
                max: 5000,
                value: 500
            }
        };
        this.licensedChapterGroups = [
            '4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb', // MangaPlus
            '8d8ecf83-8d42-4f8c-add8-60963f9f28d9' // Comikey
        ];
        this.serverNetwork = [
            'https://uploads.mangadex.org/data/'
        ];
    }

    async _initializeConnector() {
        //this.serverNetwork.push('https://reh3tgm2rs8sr.xnvda7fch4zhr.mangadex.network/data/');
        //this.serverNetwork.push('https://bddhaec337xvm.xnvda7fch4zhr.mangadex.network/data/');
        this.serverNetwork.push('https://cache.ayaya.red/mdah/data/');
        console.log(`Added Network Seeds '[ ${this.serverNetwork.join(', ')} ]' to ${this.label}`);
        // MangaDex exposes its public manga and chapter metadata via separate JSON endpoints.
        // Loading the website in Electron 6 here can stall at "Browser verification" even
        // when the JSON API is reachable. Let API calls report their own actual failures.
        return Promise.resolve();
    }

    canHandleURI(uri) {
        // See: https://www.reddit.com/r/mangadex/comments/nn584s/list_of_appssites_that_currently_use_the_mangadex/
        return [
            /https?:\/\/mangadex\.org\/title\//,
            /https?:\/\/mangastack\.cf\/manga\//,
            /https?:\/\/manga\.ayaya\.red\/manga\//,
            /https?:\/\/(www\.)?chibiview\.app\/manga\//,
            /https?:\/\/cubari\.moe\/read\/mangadex\//
        ].some(regex => regex.test(uri.href));
    }

    _createAPIRequest(uri) {
        // The current HaruNeko connector identifies itself for MangaDex API calls.
        // HakuNeko 6 maps x-user-agent to the actual User-Agent in Request.mjs.
        // Apply this only to JSON API calls, not to image CDN or cached title downloads.
        const options = Object.assign({}, this.requestOptions, {
            headers: new Headers(this.requestOptions.headers)
        });
        options.headers.set('x-user-agent', 'Hakuneko 10.0');
        options.headers.set('accept', 'application/json');
        return new Request(uri, options);
    }

    async _getMangaFromURI(uri) {
        // NOTE: The MangaDex website is still down, but there are some provisional frontends which can be used for search, copy & paste
        const regexGUID = /[a-fA-F0-9]{8}-([a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}/;
        const id = (uri.pathname.match(regexGUID) || uri.hash.match(regexGUID))[0].toLowerCase();
        const request = this._createAPIRequest(new URL('/manga/' + id, this.api));
        const {data} = await this._fetchApiJSON(request);
        return new Manga(this, id, data.attributes.title.en || Object.values(data.attributes.title).shift());
    }

    async _getMangas() {
        // The full title catalogue uses a cache service, not the MangaDex API.
        // Keep this distinct from chapter API failures and do not erase existing lists.
        const catalogue = await this.fetchJSON('https://websites.hakuneko.download/mangadex.json');
        if(!Array.isArray(catalogue)) {
            throw new Error('MangaDex title catalogue returned invalid data from websites.hakuneko.download.');
        }
        return catalogue.map(manga => ({
            id: manga.id,
            title: manga.title
        }));
    }

    /**
     * Distinguish API/anti-bot failures from a legitimate empty chapter feed.
     */
    async _fetchApiJSON(request, retries = 3) {
        try {
            const response = await this.fetchJSON(request, retries);
            if(response && Array.isArray(response.errors) && response.errors.length > 0) {
                throw new Error('MangaDex API errors: ' + response.errors.map(error =>
                    error.detail || error.title || error.message || 'unknown error'
                ).join('; '));
            }
            return response;
        } catch(error) {
            const message = error && error.message ? error.message : String(error);
            if(/status:\s*(403|429|503)\b/.test(message) || error && error.name === 'SyntaxError') {
                throw new Error('MangaDex API access failed (possible Cloudflare/PoW challenge or rate limiting): ' + message);
            }
            throw error;
        }
    }

    async _getChapters(manga) {
        let chapterList = [];
        for(let page = 0, run = true; run; page++) {
            let chapters = await this._getChaptersFromPage(manga, page);
            chapters.length > 0 ? chapterList.push(...chapters) : run = false;
        }
        return chapterList.reverse();
    }

    async _getChaptersFromPage(manga, page) {
        await this.wait(this.config.throttleRequests.value);
        const uri = new URL('/chapter', this.api);
        uri.searchParams.set('limit', 100);
        uri.searchParams.set('offset', 100 * page);
        uri.searchParams.append('contentRating[]', 'safe');
        uri.searchParams.append('contentRating[]', 'suggestive');
        uri.searchParams.append('contentRating[]', 'erotica');
        uri.searchParams.append('contentRating[]', 'pornographic');
        uri.searchParams.set('manga', manga.id);
        const request = this._createAPIRequest(uri);
        const response = await this._fetchApiJSON(request, 3);
        if(!response || !Array.isArray(response.data)) {
            throw new Error('MangaDex API returned an invalid chapter list, not zero chapters.');
        }
        const data = response.data;
        const groupMap = await this._getScanlationGroups(data);
        return !data ? [] : data.map(result => {
            let title = '';
            if(result.attributes.volume) {
                title += 'Vol.' + this._padNum(result.attributes.volume, 2);
            }
            if(result.attributes.chapter) {
                title += ' Ch.' + this._padNum(result.attributes.chapter, 4);
            }
            if(result.attributes.title) {
                title += (title ? ' - ' : '') + result.attributes.title;
            }
            if(result.attributes.translatedLanguage) {
                title += ' (' + result.attributes.translatedLanguage + ')';
            }
            const groups = result.relationships.filter(r => r.type === 'scanlation_group');
            if(groups.length > 0) {
                title += ' [' + groups.map(group => groupMap[group.id]).join(', ') + ']';
            }
            // is any group for this chapter not in the list of licensed groups?
            if(groups.length === 0 || groups.some(group => !this.licensedChapterGroups.includes(group.id))) {
                return {
                    id: result.id,
                    title: title.trim(),
                    language: result.attributes.translatedLanguage
                };
            } else {
                return false;
            }
        }).filter(chapter => chapter);
    }

    async _getPages(chapter) {
        const uri = new URL('/at-home/server/' + chapter.id, this.api);
        const request = this._createAPIRequest(uri);
        const data = await this._fetchApiJSON(request, 3);
        if(!data || !data.chapter || !Array.isArray(data.chapter.data) || !data.baseUrl) {
            throw new Error('MangaDex API returned invalid page data.');
        }
        return data.chapter.data.map(file => this.createConnectorURI({
            networkNode: data.baseUrl + '/data/', // e.g. 'https://foo.bar.mangadex.network:44300/token/data/'
            hash: data.chapter.hash, // e.g. '1c41e55e32b21321ff11907469e5c323'
            file: file // e.g. 'x1-216a1435.png'
        }));
    }

    async _handleConnectorURI(payload) {
        const servers = [
            ...this.serverNetwork,
            payload.networkNode
        ];
        for(let node of servers) {
            try {
                const uri = new URL(node + payload.hash + '/' + payload.file);
                const request = new Request(uri, this.requestOptions);
                const response = await fetch(request);
                if(response.ok && response.status === 200) {
                    const data = await response.blob();
                    if(response.headers.get('content-length') == data.size || await createImageBitmap(data)) {
                        return this._blobToBuffer(data);
                    }
                }
            } finally {/**/}
        }
        throw new Error('Failed to download image file from MangaDex@Home network!\n' + payload.networkNode);
    }

    async _getScanlationGroups(chapters) {
        const groupList = {};
        let groupIDs = !chapters ? {} : chapters.reduce((accumulator, chapter) => {
            const ids = chapter.relationships.filter(r => r.type === 'scanlation_group').map(g => g.id);
            return accumulator.concat(ids);
        }, []);
        groupIDs = Array.from(new Set(groupIDs));
        if(groupIDs.length > 0) {
            await this.wait(this.config.throttleRequests.value);
            const uri = new URL('/group', this.api);
            uri.search = new URLSearchParams([ [ 'limit', 100 ], ...groupIDs.map(id => [ 'ids[]', id ]) ]).toString();
            const request = this._createAPIRequest(uri);
            const response = await this._fetchApiJSON(request, 3);
            if(!response || !Array.isArray(response.data)) {
                throw new Error('MangaDex API returned an invalid scanlation group list.');
            }
            response.data.forEach(result => groupList[result.id] = result.attributes.name || 'unknown');
        }
        return groupList;
    }

    _padNum(number, places) {
        /*
         * '17'
         * '17.5'
         * '17-17.5'
         * '17 - 17.5'
         * '17-123456789'
         */
        let range = number.split('-');
        range = range.map(chapter => {
            chapter = chapter.trim();
            let digits = chapter.split('.')[0].length;
            return '0'.repeat(Math.max(0, places - digits)) + chapter;
        });
        return range.join('-');
    }
}
