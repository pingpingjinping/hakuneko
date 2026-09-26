const { spawnSync } = require('child_process');
const path = require('path');

// Keep automatic sync deterministic: all app/web unit suites, then the real
// updater filesystem/process tests. Live website assertions have their own
// explicit command and are never reported as passing by this runner.
for(const args of [
    [require.resolve('jest/bin/jest'), '--runInBand'].concat(process.argv.slice(2)),
    [path.join(__dirname, 'test-portable-update.js')]
]) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if(result.error) {
        console.error(result.error);
    }
    if(result.error || result.status !== 0) {
        process.exit(result.status || 1);
    }
}
