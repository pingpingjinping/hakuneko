const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

async function main() {
    if(require('../build-app.config').version !== '6.1.7') {
        throw new Error('Runtime changed; a new updater channel and manual installation are required.');
    }
    const folder = path.resolve(process.argv[2]);
    const build = {
        schema: 1,
        runtime: 'electron-6.1.7-win32-x64',
        run: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        commit: process.env.GITHUB_SHA
    };
    if(!Number.isSafeInteger(build.run) || build.run <= 0 || !Number.isSafeInteger(build.attempt) || build.attempt <= 0 || !/^[a-f0-9]{40}$/.test(build.commit)) {
        throw new Error('Missing GitHub build identity');
    }
    fs.writeFileSync(path.join(folder, 'update-build.json'), JSON.stringify(build));
    const zip = new JSZip();
    function add(name) {
        const file = path.join(folder, name);
        const stat = fs.lstatSync(file);
        if(stat.isSymbolicLink()) {
            throw new Error('Symlink in update package: ' + name);
        }
        if(stat.isDirectory()) {
            fs.readdirSync(file).sort().forEach(child => add(name + '/' + child));
        } else {
            zip.file(name, fs.readFileSync(file));
        }
    }
    add('cache');
    add('resources/app.asar');
    add('update-build.json');
    const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const asset = 'hakuneko-update-' + build.run + '-' + build.attempt + '.zip';
    fs.writeFileSync(path.join('build', asset), data);
    fs.writeFileSync(path.join('build', 'custom-update.json'), JSON.stringify(Object.assign({}, build, {
        asset,
        size: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex')
    }), null, 2));
    console.log('Prepared ' + asset);
}

main().catch(error => {
    console.error(error); process.exitCode = 1;
});
