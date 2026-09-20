const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const childProcess = require('child_process');
const JSZip = require('jszip');
// Electron treats *.asar paths as virtual directories, even in Node mode.
const rawFS = process.versions.electron ? require('original-fs') : require('fs');

const repository = 'pingpingjinping/hakuneko';
const channel = 'v6.1.7-bookmark-auto-update';
const runtime = 'electron-6.1.7-win32-x64';
const releaseURL = 'https://api.github.com/repos/' + repository + '/releases/tags/' + channel;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function validBuild(build) {
    return build && build.schema === 1 && build.runtime === runtime &&
        Number.isSafeInteger(build.run) && build.run > 0 &&
        Number.isSafeInteger(build.attempt) && build.attempt > 0 &&
        /^[a-f0-9]{40}$/.test(build.commit);
}

function newer(remote, local) {
    return validBuild(remote) && validBuild(local) &&
        (remote.run > local.run || remote.run === local.run && remote.attempt > local.attempt);
}

function safeEntry(name) {
    if(typeof name !== 'string' || name.includes('\\') || name.includes(':') || name.startsWith('/')) {
        return false;
    }
    if(name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
        return false;
    }
    return name === 'resources/app.asar' || name === 'update-build.json' || name.startsWith('cache/');
}

// Node HTTPS intentionally retains certificate validation, independently of the
// web reader's relaxed certificate handling. Requests have an overall deadline.
function request(address, limit, timeout, progress, redirects = 0) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const uri = new URL(address);
        const hosts = ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
        if(uri.protocol !== 'https:' || !hosts.includes(uri.hostname) || uri.username || uri.password || redirects > 4 || timeout <= 0) {
            reject(new Error('Invalid update download URL'));
            return;
        }
        let timer;
        const req = https.get(uri, { headers: { 'User-Agent': 'HakuNeko-Custom-Updater', 'Accept': 'application/vnd.github+json' } }, res => {
            if([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.resume();
                clearTimeout(timer);
                try {
                    if(!res.headers.location) {
                        throw new Error('Missing update redirect');
                    }
                    request(new URL(res.headers.location, address).href, limit, timeout - (Date.now() - started), progress, redirects + 1).then(resolve, reject);
                } catch(error) {
                    reject(error);
                }
                return;
            }
            if(res.statusCode !== 200) {
                res.resume();
                clearTimeout(timer);
                reject(new Error('Update HTTP status ' + res.statusCode));
                return;
            }
            const chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if(size > limit) {
                    req.destroy(new Error('Update exceeds size limit'));
                    return;
                }
                chunks.push(chunk);
                if(progress) {
                    progress(size);
                }
            });
            res.on('error', error => {
                clearTimeout(timer); reject(error);
            });
            res.on('aborted', () => {
                clearTimeout(timer); reject(new Error('Update download interrupted'));
            });
            res.on('end', () => {
                clearTimeout(timer);
                resolve(Buffer.concat(chunks));
            });
        });
        timer = setTimeout(() => req.destroy(new Error('Update request timed out')), timeout);
        req.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function extract(buffer, stage, expected) {
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
    const entries = Object.keys(zip.files).filter(name => !zip.files[name].dir);
    if(entries.length > 20000 || !entries.includes('cache/index.html') || !entries.includes('resources/app.asar') || !entries.includes('update-build.json')) {
        throw new Error('Incomplete update package');
    }
    const seen = new Set();
    let total = 0;
    for(const name of entries) {
        if(!safeEntry(name) || seen.has(name.toLowerCase())) {
            throw new Error('Unsafe or duplicate archive path');
        }
        seen.add(name.toLowerCase());
        const file = zip.files[name];
        if(file.unixPermissions && (file.unixPermissions & 0xf000) === 0xa000) {
            throw new Error('Archive symlinks are not supported');
        }
        const data = await file.async('nodebuffer');
        total += data.length;
        if(total > 512 * 1024 * 1024) {
            throw new Error('Expanded update exceeds size limit');
        }
        const destination = path.join(stage, name);
        await fs.ensureDir(path.dirname(destination));
        rawFS.writeFileSync(destination, data);
    }
    const bundled = await fs.readJson(path.join(stage, 'update-build.json'));
    if(!validBuild(bundled) || bundled.run !== expected.run || bundled.attempt !== expected.attempt || bundled.commit !== expected.commit) {
        throw new Error('Update package build does not match manifest');
    }
}

module.exports = class PortableUpdater {
    constructor(root, logger, fetch = request) {
        this.root = root;
        this.logger = logger;
        this.fetch = fetch;
    }

    async check(status) {
        let work;
        try {
            const local = await fs.readJson(path.join(this.root, 'update-build.json'));
            if(!validBuild(local) || process.env.HAKUNEKO_SKIP_UPDATE === '1' || await fs.pathExists(path.join(this.root, 'disable-auto-update'))) {
                return false;
            }
            status('업데이트 확인 중…');
            const release = JSON.parse((await this.fetch(releaseURL, 2 * 1024 * 1024, 5000)).toString('utf8'));
            if(release.draft || release.prerelease || release.tag_name !== channel) {
                return false;
            }
            const asset = release.assets.find(item => item.name === 'custom-update.json' && item.state === 'uploaded');
            if(!asset) {
                return false;
            }
            const remote = JSON.parse((await this.fetch(asset.browser_download_url, 16384, 5000)).toString('utf8'));
            if(!newer(remote, local)) {
                return false;
            }
            if(!/^hakuneko-update-[0-9]+-[0-9]+\.zip$/.test(remote.asset) || !/^[a-f0-9]{64}$/.test(remote.sha256) || !Number.isSafeInteger(remote.size) || remote.size <= 0 || remote.size > 128 * 1024 * 1024) {
                throw new Error('Invalid update manifest');
            }
            const download = release.assets.find(item => item.name === remote.asset && item.state === 'uploaded' && item.size === remote.size);
            if(!download) {
                throw new Error('Update package is not yet published');
            }
            // Work directory is on the same volume, so swaps are filesystem renames.
            work = await fs.mkdtemp(path.join(this.root, '.hakuneko-update-'));
            let percent = -1;
            const data = await this.fetch(download.browser_download_url, remote.size, 120000, size => {
                const next = Math.floor(size * 100 / remote.size);
                if(next !== percent) {
                    percent = next;
                    status('업데이트 다운로드 중… ' + percent + '%');
                }
            });
            if(data.length !== remote.size || crypto.createHash('sha256').update(data).digest('hex') !== remote.sha256) {
                throw new Error('Update checksum mismatch');
            }
            status('업데이트 준비 중…');
            await extract(data, path.join(work, 'stage'), remote);
            await fs.copy(path.join(__dirname, 'PortableUpdateHelper.js'), path.join(work, 'helper.js'));
            await fs.writeJson(path.join(work, 'job.json'), { root: this.root, exe: process.execPath, pid: process.pid });
            let spawnError;
            const child = childProcess.spawn(process.execPath, [path.join(work, 'helper.js'), work], {
                cwd: work, detached: true, stdio: 'ignore',
                env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
            });
            child.on('error', error => {
                spawnError = error;
            });
            child.unref();
            for(let count = 0; count < 100; count++) {
                if(spawnError) {
                    throw spawnError;
                }
                if(await fs.pathExists(path.join(work, 'ready'))) {
                    return true;
                }
                await pause(100);
            }
            child.kill();
            throw new Error('Update helper did not start');
        } catch(error) {
            this.logger.warn('Custom update skipped; starting current version:', error);
            if(work) {
                await fs.remove(work).catch(() => {});
            }
            return false;
        }
    }
};
module.exports.newer = newer;
module.exports.safeEntry = safeEntry;
module.exports.extract = extract;
