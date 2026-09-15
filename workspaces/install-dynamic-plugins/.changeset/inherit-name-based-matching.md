---
'@red-hat-developer-hub/cli-module-install-dynamic-plugins': minor
---

Match `{{inherit}}` by plugin name (last OCI path segment) instead of the full
OCI URL, aligning the init container with the operator's `DynaPlugin.Name()`.

Plugin identity is now the last OCI path segment, ignoring the registry host,
namespace, tag/digest, and `!plugin-path`. This makes `{{inherit}}` resolution
host- and namespace-agnostic, so a plugin published to different registries at
different pipeline stages (e.g. GHCR in development, `registry.redhat.io` in
production) resolves correctly instead of failing with an `InstallException`.
The inherited entry adopts the base plugin's version and concrete package URL,
so install still pulls from the correct registry.

`{{inherit}}` is now resolved in a pre-pass before the pre-merge disabled scan
(mirroring `ref://`), so a base that is disabled in an included catalog and
re-enabled from a different registry via `{{inherit}}` no longer gets filtered
out before the name-based merge can find it — which previously crashed the init
container with `Cannot use {{inherit}} for ...: no existing plugin configuration
found`. An explicit user `!plugin-path` on an `{{inherit}}` entry now takes
precedence over the base's path, matching the operator's
`resolveInheritReference`.

If two enabled entries at the same merge level resolve to the same plugin name,
the install now fails with an error identifying both conflicting packages. The
last OCI path segment must be unique per plugin (one plugin per image).

Existing `dynamic-plugins.yaml` configurations need no changes; explicit
`!plugin-path` overrides and explicit version overrides are unaffected.
