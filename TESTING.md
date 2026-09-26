# Automated validation

`npm test` runs all application/web unit suites, including the previously
undiscovered `ConfigurationWindows.tests.js`, and the portable updater's
checksum, rollback, data-preservation and live-process handoff tests. Failure
of either command fails the run. This is the command used by PR CI and the
scheduled upstream sync gate, alongside lint and the web build.

The HTTP test server uses an ephemeral localhost port, explicitly disables
keep-alive in its responses, and waits for listen/close completion. Error
assertions use error codes where Node versions change the message text. The
configuration tests expect the fork's disabled official updater and still
check that explicit URL overrides work.

`npm run test:e2e` separately runs the legacy live-site connector suite. It
launches Electron and accesses real websites, asserting old chapter IDs,
titles and page counts. Site downtime, changes to those contents, login or
blocking can fail that suite independently of a code change. It is preserved,
not marked skipped or successful by normal CI. It requires a desktop/display
and network access; passing automatic checks does not prove every site works.
Puppeteer Core is pinned to 1.20.0 for the legacy CommonJS test API.
Jest and its JUnit reporter are
also pinned, so install-time major updates cannot change test discovery/CLI.

PR checks run on Windows, Linux and Intel macOS. Electron 6.1.7 has no macOS
ARM build, so the macOS runner is explicitly `macos-15-intel`. Matrix jobs
report independently instead of cancelling the other platforms after a failure.
