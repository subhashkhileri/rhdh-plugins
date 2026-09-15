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
import type { OciImageCache } from './image-cache';
import { resolveInheritPlugins } from './installer';
import {
  filterDisabledOciPlugins,
  mergePlugin,
  preMergeOciDisabledState,
} from './merger';
import {
  isPluginDisabled,
  type IncludePluginList,
  type PluginMap,
  type PluginSpec,
} from './types';

/**
 * Coverage for the `resolveInheritPlugins` pre-pass and the ordering bug it
 * fixes: `{{inherit}}` must be resolved against the raw include lists BEFORE the
 * registry-keyed pre-merge disabled pass runs, otherwise a disabled base in a
 * different registry is filtered out before the name-based merge can find it.
 */

const CATALOG = 'catalog.yaml';
const MAIN = 'dynamic-plugins.yaml';

/** Same plugin name (`plugin-a`), two registries. */
const PROD_BASE = 'oci://registry.redhat.io/rhdh/plugin-a';
const DEV = 'oci://ghcr.io/example/plugin-a';
const KEY_A = 'plugin-a';

function fakeImageCache(paths: string[]): OciImageCache {
  return { getPluginPaths: async () => paths } as unknown as OciImageCache;
}

describe('resolveInheritPlugins — rewrites main {{inherit}} against the includes', () => {
  it('rewrites a cross-registry {{inherit}} to the base concrete package', () => {
    const includeLists: IncludePluginList[] = [
      [CATALOG, [{ package: `${PROD_BASE}:1.2.3!plugin-a` }]],
    ];
    const mainPlugins: PluginSpec[] = [{ package: `${DEV}:{{inherit}}` }];

    resolveInheritPlugins(mainPlugins, includeLists);

    // Adopts the base's registry and version, not the dev host.
    expect(mainPlugins[0]?.package).toBe(`${PROD_BASE}:1.2.3!plugin-a`);
  });

  it('gives an explicit user !plugin-path precedence over the base path', () => {
    const includeLists: IncludePluginList[] = [
      [CATALOG, [{ package: `${PROD_BASE}:1.2.3!base-path` }]],
    ];
    const mainPlugins: PluginSpec[] = [
      { package: `${DEV}:{{inherit}}!custom-path` },
    ];

    resolveInheritPlugins(mainPlugins, includeLists);

    expect(mainPlugins[0]?.package).toBe(`${PROD_BASE}:1.2.3!custom-path`);
  });

  it('resolves a base referenced by digest', () => {
    const includeLists: IncludePluginList[] = [
      [CATALOG, [{ package: `${PROD_BASE}@sha256:abc123` }]],
    ];
    const mainPlugins: PluginSpec[] = [{ package: `${DEV}:{{inherit}}` }];

    resolveInheritPlugins(mainPlugins, includeLists);

    expect(mainPlugins[0]?.package).toBe(`${PROD_BASE}@sha256:abc123`);
  });

  it('throws when no plugin of that name exists in the includes', () => {
    const includeLists: IncludePluginList[] = [
      [CATALOG, [{ package: 'oci://ghcr.io/org/plugin-b:1.0!plugin-b' }]],
    ];
    const mainPlugins: PluginSpec[] = [{ package: `${DEV}:{{inherit}}` }];

    expect(() => resolveInheritPlugins(mainPlugins, includeLists)).toThrow(
      InstallException,
    );
    expect(() => resolveInheritPlugins(mainPlugins, includeLists)).toThrow(
      `Cannot use {{inherit}} for '${KEY_A}'`,
    );
  });

  it('leaves non-inherit and non-OCI entries untouched', () => {
    const includeLists: IncludePluginList[] = [
      [CATALOG, [{ package: `${PROD_BASE}:1.2.3!plugin-a` }]],
    ];
    const mainPlugins: PluginSpec[] = [
      { package: `${DEV}:9.9.9!plugin-a` },
      { package: './local-plugin' },
    ];

    resolveInheritPlugins(mainPlugins, includeLists);

    expect(mainPlugins[0]?.package).toBe(`${DEV}:9.9.9!plugin-a`);
    expect(mainPlugins[1]?.package).toBe('./local-plugin');
  });
});

describe('resolveInheritPlugins — Finding 1: disabled cross-registry base must survive for inherit', () => {
  /**
   * The base is published to the Red Hat registry and disabled in the catalog;
   * the main config re-enables it via `{{inherit}}` from a *different* (ghcr)
   * registry. The pre-merge disabled pass keys on the full registry URL, so
   * without the pre-pass it treats the two registries as unrelated, drops the
   * disabled base, and the name-based inherit then fails — crashing the init
   * container. The pre-pass rewrites the main entry to the base's registry
   * first, so the re-enable at level 1 wins and nothing is filtered.
   */
  const buildScenario = (): {
    includeLists: IncludePluginList[];
    mainPlugins: PluginSpec[];
  } => ({
    includeLists: [
      [CATALOG, [{ package: `${PROD_BASE}@sha256:abc123`, disabled: true }]],
    ],
    mainPlugins: [{ package: `${DEV}:{{inherit}}`, disabled: false }],
  });

  it('without the pre-pass, the disabled base registry is filtered out (the bug)', () => {
    const { includeLists, mainPlugins } = buildScenario();

    // No resolveInheritPlugins call — reproduce the pre-fix ordering.
    const disabled = preMergeOciDisabledState(includeLists, mainPlugins, MAIN);

    // The Red Hat base registry is disabled and would be dropped before merge.
    expect(disabled.has(`${PROD_BASE}`)).toBe(true);
    const survivors = filterDisabledOciPlugins(includeLists[0]![1], disabled);
    expect(survivors).toHaveLength(0);
  });

  it('with the pre-pass, nothing is disabled and inherit resolves end-to-end', async () => {
    const { includeLists, mainPlugins } = buildScenario();

    resolveInheritPlugins(mainPlugins, includeLists);

    const disabled = preMergeOciDisabledState(includeLists, mainPlugins, MAIN);
    // The main config re-enabled the base registry at a higher level.
    expect(disabled.size).toBe(0);

    const cache = fakeImageCache([KEY_A]);
    const all: PluginMap = {};
    for (const [file, plugins] of includeLists) {
      for (const plugin of filterDisabledOciPlugins(plugins, disabled)) {
        await mergePlugin(plugin, all, file, /* level */ 0, cache);
      }
    }
    for (const plugin of filterDisabledOciPlugins(mainPlugins, disabled)) {
      await mergePlugin(plugin, all, MAIN, /* level */ 1, cache);
    }

    // The inherit resolved instead of throwing, folding into a single entry that
    // pulls from the base registry and is enabled (level-1 override wins).
    expect(Object.keys(all)).toEqual([KEY_A]);
    expect(all[KEY_A]?.package).toBe(`${PROD_BASE}@sha256:abc123!${KEY_A}`);
    expect(isPluginDisabled(all[KEY_A]!)).toBe(false);
  });
});
