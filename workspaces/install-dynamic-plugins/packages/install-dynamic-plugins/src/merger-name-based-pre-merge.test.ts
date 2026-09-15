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
import type { OciImageCache } from './image-cache';
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
 * End-to-end coverage for the ordering bug fixed by name-based pre-merge
 * disabled-state handling: a disabled catalog base must remain available when
 * a higher-level cross-registry `{{inherit}}` entry re-enables it.
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

describe('name-based pre-merge state — disabled cross-registry base survives for inherit', () => {
  /**
   * The base is published to the Red Hat registry and disabled in the catalog;
   * the main config re-enables it via `{{inherit}}` from a *different* (ghcr)
   * registry. Both entries now share the name-based key, so the higher-level
   * enabled state wins before filtering and the merger can resolve inherit.
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

  it('does not filter the disabled base after the higher level re-enables its name', () => {
    const { includeLists, mainPlugins } = buildScenario();

    const disabled = preMergeOciDisabledState(includeLists, mainPlugins, MAIN);
    expect(disabled.size).toBe(0);
    const survivors = filterDisabledOciPlugins(includeLists[0]![1], disabled);
    expect(survivors).toHaveLength(1);
  });

  it('resolves inherit end-to-end after name-based disabled filtering', async () => {
    const { includeLists, mainPlugins } = buildScenario();

    const disabled = preMergeOciDisabledState(includeLists, mainPlugins, MAIN);
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
