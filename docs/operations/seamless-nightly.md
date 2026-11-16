# Seamless nightly fork

The `seamless-nightly` branch carries the Seamless integration over published
T3 Code nightlies. The **Seamless nightly** workflow checks hourly, merges the
latest published upstream nightly, checks the overlay, builds and smoke-tests
Windows x64, Linux x64 and macOS arm64 packages, then publishes a prerelease
with the desktop update manifests and CLI checksums. It does not publish to npm
or change the upstream repository.

The sync job uses the private `SEAMLESS_SYNC_TOKEN` Actions secret, which needs
repository content and workflow write access so upstream workflow changes can
merge too. Build jobs do not receive it. Rotate it if the saved GitHub login is
revoked; the normal per-run GitHub token handles release publication.

Install a fork installer once and keep the app on the Nightly update track.
Subsequent desktop and managed CLI updates come from this fork, including the
Seamless integration. An official installer replaces it with upstream code.
Existing app data stays in the normal T3 home; never run two servers against it.

Fork version build numbers combine the upstream nightly number and this
workflow's run number, preserving normal nightly version parsing and ordering.
An upstream merge conflict, failed check or failed platform build blocks
publication. The previous working release remains available; someone must fix
incompatible upstream changes before new features can ship. Run the workflow
manually to rebuild the current nightly after a fix.

Signing credentials are not copied from upstream. Without fork signing
credentials the platform packages use upstream's unsigned/ad-hoc build path.
The app's normal update checks and platform approval rules still apply.
