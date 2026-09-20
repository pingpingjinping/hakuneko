const assert = require('assert');
const path = require('path');
// Resolve the same pinned dependencies shipped inside app.asar, not the newer
// build-tool dependencies at repository root (which need a newer Node).
const appModules = { paths: [path.join(__dirname, '../src/app')] };
const fs = require(require.resolve('fs-extra', appModules));
const os = require('os');
const JSZip = require(require.resolve('jszip', appModules));
const childProcess = require('child_process');
const { newer, safeEntry, extract } = require('../src/app/PortableUpdater');
const PortableUpdater = require('../src/app/PortableUpdater');
const { install, main: runHelper } = require('../src/app/PortableUpdateHelper');

const build = { schema: 1, runtime: 'electron-6.1.7-win32-x64', run: 200, attempt: 1, commit: 'a'.repeat(40) };

async function reject(promise) {
    let failed = false;
    try {
        await promise;
    } catch(error) {
        failed = true;
    }
    assert(failed, 'Expected operation to reject');
}

async function main() {
    assert(newer(build, Object.assign({}, build, { run: 100 })));
    assert(!newer(build, build));
    assert(!newer(build, Object.assign({}, build, { run: 300 })));
    assert(newer(Object.assign({}, build, { attempt: 2 }), build));
    assert(!newer(Object.assign({}, build, { runtime: 'other' }), build));
    assert(!newer(Object.assign({}, build, { run: '201' }), build));
    for(const name of ['../userdata/a', 'cache/../../a', 'cache\\a', 'cache/a:stream', '/cache/a', 'userdata/a', 'resources/other', 'cache/a./b']) {
        assert(!safeEntry(name), name);
    }
    assert(safeEntry('cache/mjs/a.mjs'));
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hakuneko-updater-test-'));
    try {
        const zip = new JSZip();
        zip.file('cache/index.html', 'new app');
        zip.file('resources/app.asar', 'new code');
        zip.file('update-build.json', JSON.stringify(build));
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });
        const work = path.join(temp, 'work');
        await extract(buffer, path.join(work, 'stage'), build);
        await reject(extract(buffer, path.join(temp, 'wrong'), Object.assign({}, build, { run: 300 })));
        zip.file('userdata/bookmarks', 'must not overwrite');
        await reject(extract(await zip.generateAsync({ type: 'nodebuffer' }), path.join(temp, 'unsafe'), build));
        const root = path.join(temp, 'app');
        await fs.outputFile(path.join(root, 'cache/index.html'), 'old app');
        await fs.outputFile(path.join(root, 'resources/app.asar'), 'old code');
        await fs.outputFile(path.join(root, 'update-build.json'), 'old build');
        await fs.outputFile(path.join(root, 'userdata/bookmarks'), 'my bookmarks');
        await fs.outputFile(path.join(root, 'Mangas/chapter.zip'), 'my download');
        await fs.outputFile(path.join(root, 'resources/other'), 'leave alone');
        // Fail after some files have already moved; ensure the entire previous
        // version is restored, including build identity and unchanged user data.
        let moves = 0;
        await reject(install(root, work, async (from, to) => {
            if(++moves === 4) {
                throw new Error('simulated sharing violation/disk failure');
            }
            await fs.rename(from, to);
        }));
        assert.strictEqual(await fs.readFile(path.join(root, 'cache/index.html'), 'utf8'), 'old app');
        assert.strictEqual(await fs.readFile(path.join(root, 'resources/app.asar'), 'utf8'), 'old code');
        assert.strictEqual(await fs.readFile(path.join(root, 'update-build.json'), 'utf8'), 'old build');
        await install(root, work);
        assert.strictEqual(await fs.readFile(path.join(root, 'cache/index.html'), 'utf8'), 'new app');
        assert.strictEqual(await fs.readFile(path.join(root, 'resources/app.asar'), 'utf8'), 'new code');
        assert.strictEqual(await fs.readFile(path.join(root, 'userdata/bookmarks'), 'utf8'), 'my bookmarks');
        assert.strictEqual(await fs.readFile(path.join(root, 'Mangas/chapter.zip'), 'utf8'), 'my download');
        assert.strictEqual(await fs.readFile(path.join(root, 'resources/other'), 'utf8'), 'leave alone');
        assert.strictEqual(await fs.readFile(path.join(work, 'backup/resources/app.asar'), 'utf8'), 'old code');

        // Exercise the exact build script, then consume its output with the client.
        await fs.ensureDir(path.join(temp, 'build'));
        childProcess.execFileSync(process.execPath, [path.resolve(__dirname, 'build-portable-update.js'), root], {
            cwd: temp,
            env: Object.assign({}, process.env, { GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: build.commit })
        });
        const manifest = await fs.readJson(path.join(temp, 'build/custom-update.json'));
        const payload = await fs.readFile(path.join(temp, 'build', manifest.asset));
        assert.strictEqual(payload.length, manifest.size);
        const crypto = require('crypto');
        assert.strictEqual(crypto.createHash('sha256').update(payload).digest('hex'), manifest.sha256);
        await extract(payload, path.join(temp, 'generated'), manifest);
        assert(!await fs.pathExists(path.join(temp, 'generated/userdata')));
        // A failed download/checksum must never reach the installer or modify
        // the current app. The test transport returns the same release shapes.
        await fs.writeJson(path.join(root, 'update-build.json'), build);
        const release = { tag_name: 'v6.1.7-bookmark-auto-update', assets: [
            { name: 'custom-update.json', state: 'uploaded', browser_download_url: 'manifest' },
            { name: manifest.asset, state: 'uploaded', size: payload.length, browser_download_url: 'payload' }
        ] };
        let warnings = 0;
        const logger = { warn: () => {
            warnings++;
        } };
        const broken = new PortableUpdater(root, logger, async address => {
            if(address === 'manifest') {
                return Buffer.from(JSON.stringify(manifest));
            }
            if(address === 'payload') {
                return Buffer.alloc(payload.length);
            }
            return Buffer.from(JSON.stringify(release));
        });
        assert.strictEqual(await broken.check(() => {}), false);
        assert.strictEqual(warnings, 1);
        assert.strictEqual(await fs.readFile(path.join(root, 'resources/app.asar'), 'utf8'), 'new code');
        assert.deepStrictEqual(await fs.readJson(path.join(root, 'update-build.json')), build);
        const offline = new PortableUpdater(root, logger, async () => {
            throw new Error('offline');
        });
        assert.strictEqual(await offline.check(() => {}), false);
        assert.strictEqual(warnings, 2);
        await fs.outputFile(path.join(root, 'disable-auto-update'), '');
        assert.strictEqual(await offline.check(() => {}), false);
        assert.strictEqual(warnings, 2);

        // Use a live child to verify handoff: no replacement until it exits,
        // then exactly one normal app restart with Node mode removed.
        const helperWork = path.join(temp, 'handoff');
        await extract(payload, path.join(helperWork, 'stage'), manifest);
        const parent = childProcess.spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'], {
            env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
            stdio: ['ignore', 'pipe', 'ignore']
        });
        try {
            await new Promise((resolve, reject) => {
                parent.stdout.once('data', resolve);
                parent.once('error', reject);
                parent.once('exit', () => reject(new Error('Parent fixture exited early')));
            });
            await fs.writeJson(path.join(helperWork, 'job.json'), { root, exe: process.execPath, pid: parent.pid });
            let restarted = 0;
            const running = runHelper(helperWork, (exe, args, options) => {
                restarted++;
                assert.strictEqual(options.env.ELECTRON_RUN_AS_NODE, undefined);
                assert.strictEqual(options.env.HAKUNEKO_SKIP_UPDATE, '1');
                return { on: () => {}, unref: () => {} };
            });
            await new Promise(resolve => setTimeout(resolve, 300));
            assert(await fs.pathExists(path.join(helperWork, 'ready')));
            assert.strictEqual(restarted, 0);
            assert.deepStrictEqual(await fs.readJson(path.join(root, 'update-build.json')), build);
            parent.kill();
            await running;
            assert.strictEqual(restarted, 1);
            assert.strictEqual((await fs.readJson(path.join(root, 'update-build.json'))).run, 201);
        } finally {
            parent.kill();
        }
        console.log('PASS: versions, unsafe paths, manifest mismatch, rollback, data preservation, packaging, checksum rejection, offline startup, opt-out, parent-exit handoff');
    } finally {
        await fs.remove(temp);
    }
}

main().catch(error => {
    console.error(error); process.exitCode = 1;
});
