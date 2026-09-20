# Custom portable updates

Install the first portable ZIP containing this change manually, preserving your
existing `userdata` folder. Later normal launches of the Windows x64 portable
app check `pingpingjinping/hakuneko` Releases, tag
`v6.1.7-bookmark-auto-update`, before starting bookmark checks/downloads.
Nothing is downloaded from the official HakuNeko updater.

Build run ID + attempt identify versions even though the release name and
application version stay the same. The new payload has a unique filename;
`custom-update.json` is uploaded last. The client checks the payload's size,
SHA-256, archive paths and embedded build identity before installation.
Older builds, incomplete publications, invalid responses and network failures
leave the current installation running. Metadata requests time out after five
seconds each; downloads have a two-minute limit per request.

The app shows download progress, stages the update on the same drive, closes,
and a helper running on the existing Electron runtime replaces only `cache`,
`resources/app.asar` and `update-build.json`. It then restarts the app, skipping
the update check once. The current 6.1.7 channel has a fixed Electron runtime;
changes to Electron/native binaries require a manual portable ZIP install.
Custom command-line launches, nonportable installs and other platforms are
excluded. A second normal instance exits to avoid concurrent startup updates.

`userdata`, bookmarks, settings, bookmark update state and manga downloads are
not included in update packages. Do not store personal files inside the
application-owned `cache` directory. Installation move failures trigger rollback
of the application files and a restart of the previous version. Backups and
results are retained in `.hakuneko-update-*` inside the portable folder for
diagnosis. A power loss or filesystem failure during replacement/rollback may
require manual restoration from that backup; this is not a guarantee against
all update interruptions or against application bugs in a successfully installed
build. The updater does not request administrator rights.

To temporarily disable checks, create an empty file named `disable-auto-update`
alongside the executable. Remove it to enable checks again. If the repository is
private, anonymous update requests fail and the app continues with its current
version; no GitHub credentials are stored on the PC.

Release CI tests packaging, rollback and data preservation before building.
Pull requests build and test without publishing. The Linux development checks
cannot establish Windows runtime behavior; verify the first Windows CI build
and one real portable upgrade before relying on unattended updates.
