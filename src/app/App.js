const path = require('path');
const { ConsoleLogger } = require('@logtrine/logtrine');
const Configuration = require('./Configuration');
const ConfigurationLinux = require('./ConfigurationLinux');
const ConfigurationDarwin = require('./ConfigurationDarwin');
const ConfigurationWindows = require('./ConfigurationWindows');
const CommandlineArgumentExtractor = require('./CommandlineArgumentExtractor');
const UpdateServerManager = require('./UpdateServerManager');
const CacheDirectoryManager = require('./CacheDirectoryManager');
const Updater = require('./Updater');
const ElectronBootstrap = require('./ElectronBootstrap');
const PortableUpdater = require('./PortableUpdater');
const electron = require('electron');

const loadingPage = `
<div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -100%); font-family: monospace; font-size: 1.25em; font-weight: bold; text-align: center; opacity: 0.33;">
    <div style="margin-bottom: 1.5em;">Checking for Update</div>
    <progress></progress>
</div>
`;

module.exports = class App {

    constructor(logger) {
        this._logger = logger || new ConsoleLogger(ConsoleLogger.LEVEL.Warn);
        this._extractor = new CommandlineArgumentExtractor(process.argv);
        this._configuration = this._getConfiguration(this._extractor.options);
        let serverManager = new UpdateServerManager(this._configuration.applicationUpdateURL, this._logger);
        let cacheManager = new CacheDirectoryManager(this._configuration.applicationCacheDirectory, this._logger);
        this._updater = new Updater(serverManager, cacheManager, this._logger);
        this._electron = new ElectronBootstrap(this._configuration, this._logger);
    }

    _getConfiguration(options) {
        if(Configuration.isPortableMode) {
            return new Configuration(options);
        }
        if(process.platform === 'linux') {
            return new ConfigurationLinux(options);
        }
        if(process.platform === 'darwin') {
            return new ConfigurationDarwin(options);
        }
        if(process.platform === 'win32') {
            return new ConfigurationWindows(options);
        }
    }

    printInfo() {
        let separator = '--------------';
        console.log('');
        console.log(separator);
        console.log('Framework Info');
        console.log(separator );
        console.log('Electron :', process.versions.electron);
        console.log('Chrome   :', process.versions.chrome);
        console.log('Node     :', process.versions.node);
        console.log('');
    }

    async run() {
        try {
            this._extractor.printInfo();
            this.printInfo();
            this._configuration.printInfo();
            // add HakuNeko's application directory to the environment variable path (make ffmpeg available on windows)
            process.env.PATH = path.dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH;
            // add HakuNeko's portable mode as environment variable to be easily available in render process
            if(Configuration.isPortableMode) {
                process.env.HAKUNEKO_PORTABLE = 'TRUE';
            } else {
                delete process.env.HAKUNEKO_PORTABLE;
            }
            const customPortable = process.platform === 'win32' && process.arch === 'x64' &&
                Configuration.isPortableMode && process.argv.length === 1;
            if(customPortable) {
                electron.app.setPath('userData', this._configuration.applicationUserDataDirectory);
                if(!electron.app.requestSingleInstanceLock()) {
                    electron.app.exit(0);
                    return;
                }
            }
            await this._electron.launch();
            await this._electron.loadHTML(loadingPage);
            if(customPortable) {
                const updater = new PortableUpdater(path.dirname(process.execPath), this._logger);
                const restarting = await updater.check(message => {
                    this._electron.loadHTML('<div style="padding:48px;font:20px sans-serif">' + message + '</div>').catch(() => {});
                });
                if(restarting) {
                    // The renderer has not loaded yet; there are no download jobs.
                    // exit bypasses the reader's close handler, which cancels quit.
                    electron.app.exit(0);
                    return;
                }
            }
            await this._updater.updateCache(this._configuration.publicKey);
            this._electron.loadURL(this._configuration.applicationStartupURL);
        } catch(error) {
            this._logger.error('Failed to start application!', error);
        }
    }
};
