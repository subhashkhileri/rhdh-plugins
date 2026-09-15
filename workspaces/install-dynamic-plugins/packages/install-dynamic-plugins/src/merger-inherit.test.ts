/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { InstallException } from './errors';
import { mergePlugin } from './merger';
import type { Plugin, PluginMap } from './types';

/**
 * Coverage for the name-based `{{inherit}}` resolution in `mergeOciPlugin` /
 * `resolveInherit`.
 *
 * Plugins are keyed by their name — the last OCI path segment — so the registry
 * host and namespace are ignored. This mirrors the operator's
 * `DynaPlugin.Name()` matching and is what lets `{{inherit}}` resolve across
 * pipeline stages that publish the same plugin to different registries.
 *
 * `merger-pre-merge.test.ts` also spells `{{inherit}}` in its fixtures, but
 * `preMergeOciDisabledState` never parses the tag — it only reads the registry
 * and the `!path` suffix — so those occurrences exercise none of this file's
 * behaviour.
 *
 * Every package string below either carries an explicit `!<plugin-path>` or is
 * a path-less `{{inherit}}`. Both return from `ociPluginKey` before
 * `autoDetectPluginPath` is reached, so no OCI image cache — and therefore no
 * skopeo call — is ever needed.
 */

/** The plugin published to two different registries at different pipeline stages. */
const DEV_REGISTRY = 'oci://ghcr.io/org/plugin-a';
const PROD_REGISTRY = 'oci://registry.redhat.io/rhdh/plugin-a';
/** A second, differently-named plugin. */
const REGISTRY_B = 'oci://ghcr.io/org/plugin-b';

/** Both `plugin-a` registries resolve to this one name-based key. */
const KEY_A = 'plugin-a';
const KEY_B = 'plugin-b';

const MAIN_FILE = 'main.yaml';
const INCLUDE_FILE = 'include.yaml';

/** Version shipped by the include — the one `{{inherit}}` must adopt. */
const NEWER = '1.10.2';
/** An older sibling — must never be picked silently. */
const OLDER = '1.9.0';

/** Merge an include entry (level 0), the lower-precedence source. */
async function seedInclude(
  all: PluginMap,
  pkg: string,
  file = INCLUDE_FILE,
): Promise<void> {
  await mergePlugin({ package: pkg }, all, file, /* level */ 0);
}

/** Merge an entry from the main config (level 1), which outranks the includes. */
function mergeMain(all: PluginMap, plugin: Plugin): Promise<void> {
  return mergePlugin(plugin, all, MAIN_FILE, /* level */ 1);
}

/**
 * Run `merge`, assert it failed with an `InstallException`, and hand back the
 * message so several parts of it can be asserted without merging again —
 * re-running would assert later parts against a mutated `allPlugins`.
 */
async function installErrorMessage(
  merge: () => Promise<unknown>,
): Promise<string> {
  try {
    await merge();
  } catch (err) {
    expect(err).toBeInstanceOf(InstallException);
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the merge to throw an InstallException');
}

describe('mergePlugin — OCI {{inherit}} matches by name across registries', () => {
  it('resolves against a base published to a different registry', async () => {
    const all: PluginMap = {};
    // Base comes from the production registry via an included catalog file.
    await seedInclude(all, `${PROD_REGISTRY}:${NEWER}!plugin-a`);

    // The user references the *dev* registry — a different host and namespace —
    // yet the last path segment (`plugin-a`) is the same.
    const plugin: Plugin = { package: `${DEV_REGISTRY}:{{inherit}}` };
    await mergeMain(all, plugin);

    // The override is rewritten to the base's concrete package, so install
    // pulls from the registry the catalog actually shipped, not the dev host.
    expect(plugin.package).toBe(`${PROD_REGISTRY}:${NEWER}!plugin-a`);
    // Only one entry, keyed by name, carrying the inherited version.
    expect(Object.keys(all)).toEqual([KEY_A]);
    expect(all[KEY_A]?.version).toBe(NEWER);
    expect(all[KEY_A]?.package).toBe(`${PROD_REGISTRY}:${NEWER}!plugin-a`);
  });

  it('logs the version and path it inherited', async () => {
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const all: PluginMap = {};
      await seedInclude(all, `${PROD_REGISTRY}:${NEWER}!plugin-a`);
      await mergeMain(all, { package: `${DEV_REGISTRY}:{{inherit}}` });

      const out = write.mock.calls.map(args => String(args[0])).join('\n');
      expect(out).toContain(
        `Inheriting version \`${NEWER}\` and plugin path \`plugin-a\` for ${KEY_A}`,
      );
    } finally {
      write.mockRestore();
    }
  });
});

describe('mergePlugin — OCI {{inherit}} with no resolvable base', () => {
  it('reports the missing base configuration when nothing of that name was merged', async () => {
    const all: PluginMap = {};

    const message = await installErrorMessage(() =>
      mergeMain(all, { package: `${DEV_REGISTRY}:{{inherit}}` }),
    );

    expect(message).toContain(
      `Cannot use {{inherit}} for '${KEY_A}': no existing plugin configuration found.`,
    );
    expect(message).toContain(
      `Ensure a plugin named '${KEY_A}' is defined in an included file with an explicit version.`,
    );
    expect(all).toEqual({});
  });

  it('does not treat a differently-named plugin as a base', async () => {
    const all: PluginMap = {};
    await seedInclude(all, `${REGISTRY_B}:${NEWER}!plugin-b`);

    const message = await installErrorMessage(() =>
      mergeMain(all, { package: `${DEV_REGISTRY}:{{inherit}}` }),
    );

    expect(message).toContain(
      `Cannot use {{inherit}} for '${KEY_A}': no existing plugin configuration found.`,
    );
    // The unrelated plugin is left untouched.
    expect(Object.keys(all)).toEqual([KEY_B]);
    expect(all[KEY_B]?.version).toBe(NEWER);
  });
});

describe('mergePlugin — duplicate last-segment detection', () => {
  it('rejects two plugins that resolve to the same name at the same level', async () => {
    const all: PluginMap = {};
    // Same last segment (`plugin-a`), different registries, both at level 0.
    await seedInclude(
      all,
      `${PROD_REGISTRY}:${NEWER}!plugin-a`,
      'include-a.yaml',
    );

    const message = await installErrorMessage(() =>
      seedInclude(all, `${DEV_REGISTRY}:${OLDER}!plugin-a`, 'include-b.yaml'),
    );

    // The error identifies both conflicting entries and the shared name.
    expect(message).toContain(`${DEV_REGISTRY}:${OLDER}!plugin-a`);
    expect(message).toContain(`${PROD_REGISTRY}:${NEWER}!plugin-a`);
    expect(message).toContain(`the plugin name '${KEY_A}'`);
    expect(message).toContain('include-b.yaml');
    // The first entry survives; the collision aborts before a second is stored.
    expect(all[KEY_A]?.package).toBe(`${PROD_REGISTRY}:${NEWER}!plugin-a`);
  });
});

describe('mergePlugin — OCI {{inherit}} matching a base without a version', () => {
  it('reports the broken invariant instead of inheriting `undefined`', async () => {
    // `mergeOciPlugin` always assigns `plugin.version` before storing a plugin,
    // so this state is not reachable through the merger itself — hence the
    // `Internal:` prefix. The map is seeded by hand to exercise the guard.
    const all: PluginMap = {
      [KEY_A]: { package: `${PROD_REGISTRY}:${NEWER}!plugin-a` },
    };

    const message = await installErrorMessage(() =>
      mergeMain(all, { package: `${DEV_REGISTRY}:{{inherit}}` }),
    );

    expect(message).toContain(
      `Internal: inherited plugin '${KEY_A}' has no version`,
    );
  });
});

describe('mergePlugin — OCI {{inherit}} with an explicit !plugin-path', () => {
  it('reports the unresolved tag when the referenced path was never merged', async () => {
    const all: PluginMap = {};
    const pkg = `${DEV_REGISTRY}:{{inherit}}!plugin-a`;

    const message = await installErrorMessage(() =>
      mergeMain(all, { package: pkg }),
    );

    expect(message).toContain(
      '{{inherit}} tag is set and there is currently no resolved tag or digest',
    );
    // The package and the config file are named so the operator can find the
    // offending entry without reading the whole config.
    expect(message).toContain(`for ${pkg} in ${MAIN_FILE}.`);
    expect(all).toEqual({});
  });

  it('keeps the base version and package when the referenced path exists', async () => {
    const all: PluginMap = {};
    await seedInclude(all, `${PROD_REGISTRY}:${NEWER}!plugin-a`);

    await mergeMain(all, {
      package: `${DEV_REGISTRY}:{{inherit}}!plugin-a`,
      pluginConfig: { app: { title: 'overridden' } },
    });

    // The `{{inherit}}` literal must never reach the merged record.
    expect(all[KEY_A]?.version).toBe(NEWER);
    expect(all[KEY_A]?.package).toBe(`${PROD_REGISTRY}:${NEWER}!plugin-a`);
    expect(all[KEY_A]?.pluginConfig).toEqual({ app: { title: 'overridden' } });
    expect(all[KEY_A]?.last_modified_level).toBe(1);
    expect(Object.keys(all)).toEqual([KEY_A]);
  });
});

describe('mergePlugin — OCI {{inherit}} resolving against a single base', () => {
  it('folds into the existing entry and carries the override fields', async () => {
    const all: PluginMap = {};
    await seedInclude(all, `${PROD_REGISTRY}:${NEWER}!plugin-a`);

    const plugin: Plugin = {
      package: `${DEV_REGISTRY}:{{inherit}}`,
      disabled: true,
    };
    await mergeMain(all, plugin);

    // `resolveInherit` documents that it rewrites `plugin.package` in place to
    // the base's concrete URL — this is the only assertion of that contract.
    expect(plugin.package).toBe(`${PROD_REGISTRY}:${NEWER}!plugin-a`);
    // It folds into the existing entry instead of creating a path-less one.
    expect(Object.keys(all)).toEqual([KEY_A]);
    expect(all[KEY_A]?.version).toBe(NEWER);
    expect(all[KEY_A]?.disabled).toBe(true);
    expect(all[KEY_A]?.last_modified_level).toBe(1);
  });
});

describe('mergePlugin — OCI explicit version override', () => {
  it('lets the main config outrank an include, unlike {{inherit}}', async () => {
    const all: PluginMap = {};
    await seedInclude(all, `${PROD_REGISTRY}:${NEWER}!plugin-a`);

    // The main config outranks the includes, so an explicit tag there is an
    // intentional override — the case `{{inherit}}` deliberately opts out of.
    // It matches the base by name even though the registry differs.
    await mergeMain(all, { package: `${DEV_REGISTRY}:2.0.0!plugin-a` });

    expect(all[KEY_A]?.version).toBe('2.0.0');
    expect(all[KEY_A]?.package).toBe(`${DEV_REGISTRY}:2.0.0!plugin-a`);
  });
});
