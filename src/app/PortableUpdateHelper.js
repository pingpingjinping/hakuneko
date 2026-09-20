// Run by the existing Electron binary with ELECTRON_RUN_AS_NODE=1.
// Only these application paths are owned by the updater; userdata and downloads
// are never part of the transaction. No npm modules are needed by this helper.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const owned = ['cache', 'resources/app.asar', 'update-build.json'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function exists(file) {
    return fs.existsSync(file);
}

function assertPlain(file) {
    if(exists(file) && fs.lstatSync(file).isSymbolicLink()) {
        throw new Error('Refusing to replace a symbolic link: ' + file);
    }
}

async function rename(source, target) {
    for(let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(source, target);
            return;
        } catch(error) {
            if(attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
                throw error;
            }
            await pause(250);
        }
    }
}

async function install(root, work, move = rename) {
    const backup = path.join(work, 'backup');
    const stage = path.join(work, 'stage');
    const journal = [];
    assertPlain(root);
    assertPlain(path.join(root, 'resources'));
    fs.mkdirSync(backup, { recursive: true });
    try {
        for(const name of owned) {
            const target = path.join(root, name);
            const saved = path.join(backup, name);
            assertPlain(target);
            if(!exists(path.join(stage, name))) {
                throw new Error('Incomplete staged update: ' + name);
            }
            fs.mkdirSync(path.dirname(saved), { recursive: true });
            const entry = { name, saved: false, installed: false };
            journal.push(entry);
            if(exists(target)) {
                await move(target, saved);
                entry.saved = true;
            }
            await move(path.join(stage, name), target);
            entry.installed = true;
        }
    } catch(error) {
        // Move the failed new files out of the way and restore the old version.
        // Keep all files on disk if rollback itself fails; never delete backups.
        try {
            for(const entry of journal.reverse()) {
                const target = path.join(root, entry.name);
                if(entry.installed) {
                    await rename(target, path.join(stage, entry.name));
                }
                if(entry.saved) {
                    await rename(path.join(backup, entry.name), target);
                }
            }
        } catch(rollbackError) {
            rollbackError.rollbackFailed = true;
            throw rollbackError;
        }
        throw error;
    }
}

async function main(work, launch = childProcess.spawn) {
    const config = JSON.parse(fs.readFileSync(path.join(work, 'job.json'), 'utf8'));
    // Handshake before the parent exits; never replace files while it is alive.
    fs.writeFileSync(path.join(work, 'ready'), 'ready');
    const deadline = Date.now() + 30000;
    let waiting = true;
    while(waiting) {
        try {
            process.kill(config.pid, 0);
        } catch(error) {
            if(error.code === 'ESRCH') {
                waiting = false;
                continue;
            }
            throw error;
        }
        if(Date.now() > deadline) {
            throw new Error('Application did not exit; update was not installed.');
        }
        await pause(200);
    }
    try {
        await install(config.root, work);
        fs.writeFileSync(path.join(work, 'result'), 'installed');
    } catch(error) {
        fs.writeFileSync(path.join(work, 'result'), 'failed: ' + error.stack);
        // install() has restored the previous application on ordinary failures.
        if(error.rollbackFailed) {
            return;
        }
    }
    const environment = Object.assign({}, process.env, { HAKUNEKO_SKIP_UPDATE: '1' });
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = launch(config.exe, [], {
        cwd: config.root,
        detached: true,
        stdio: 'ignore',
        env: environment
    });
    child.on('error', error => fs.writeFileSync(path.join(work, 'result'), 'Restart failed: ' + error.message));
    child.unref();
}

module.exports = { install, main };
if(require.main === module) {
    main(process.argv[2]).catch(error => {
        fs.writeFileSync(path.join(process.argv[2], 'result'), error.stack);
        process.exitCode = 1;
    });
}
