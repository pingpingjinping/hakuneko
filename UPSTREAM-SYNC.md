# Official stable synchronization

`Sync upstream stable` lives on the default `master` branch, so GitHub can
schedule it daily at approximately 06:23 Korea time (21:23 UTC).
Merge this change into **master**, not the custom build branch.
It can also be started in Actions with **Run workflow**.

The source is `manga-download/hakuneko:6.1.7`; the destination is this
repository's `6.1.7`. This does not track upstream master/nightly or migrate
to a different major/stable branch. Those require a separate compatibility
review. If official 6.1.7 does not change, there is nothing to merge.

The workflow creates a normal merge locally, then runs lint, the web build,
and the repository test suite. Only passing merges are pushed. Conflicts,
unrelated/reset history, protected custom-file changes, or failed checks
stop the run and leave the branch unchanged. Concurrent branch changes also
stop publication; there is no force push. The custom bookmark manager,
updater configuration and workflow files require manual review if upstream
changes them. Passing tests cannot guarantee that every website works.

After synchronization, the existing Windows Portable Release workflow is
explicitly dispatched when the current commit has no successful or active
build. This is necessary because pushes made with GITHUB_TOKEN do not
trigger ordinary push workflows. Missing or failed release builds are
retried on subsequent runs. A ZIP build failure does not roll back a
validated source merge. The existing release workflow still updates its
current release asset, as before.

No personal access token is required. Actions must be enabled and repository
policy must permit the declared contents/actions write permissions. Failures
are visible in Actions and its run summary; this does not create issues or
send messages. GitHub may disable scheduled workflows in inactive public
repositories after 60 days; re-enable the workflow in Actions if necessary.

PC installation and the disabled official in-app updater are unchanged.
Download the resulting ZIP manually when you want to update your PC.
