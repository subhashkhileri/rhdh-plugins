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
import { filterDisabledOciPlugins, preMergeOciDisabledState } from './merger';
import type { PluginSpec } from './types';

describe('preMergeOciDisabledState — level overrides', () => {
  const cases: Array<{
    name: string;
    include: PluginSpec[];
    main: PluginSpec[];
    expectDisabled: boolean;
  }> = [
    {
      name: 'include enabled, main disabled (path-less inherit) → effectively disabled',
      include: [
        { package: 'oci://registry.example.com/plugin:1.0', disabled: false },
      ],
      main: [
        {
          package: 'oci://registry.example.com/plugin:{{inherit}}',
          disabled: true,
        },
      ],
      expectDisabled: true,
    },
    {
      name: 'include disabled, main re-enables → not disabled',
      include: [
        { package: 'oci://registry.example.com/plugin:1.0', disabled: true },
      ],
      main: [
        {
          package: 'oci://registry.example.com/plugin:{{inherit}}',
          disabled: false,
        },
      ],
      expectDisabled: false,
    },
    {
      name: 'include disabled, no main entry → disabled',
      include: [
        { package: 'oci://registry.example.com/plugin:1.0', disabled: true },
      ],
      main: [],
      expectDisabled: true,
    },
    {
      name: 'cross-form: path-less include enabled, explicit-path main disabled → disabled',
      include: [
        { package: 'oci://registry.example.com/plugin:1.0', disabled: false },
      ],
      main: [
        {
          package: 'oci://registry.example.com/plugin:1.0!my-plugin',
          disabled: true,
        },
      ],
      expectDisabled: true,
    },
    {
      name: 'cross-form: explicit-path include enabled, path-less main disabled → disabled',
      include: [
        {
          package: 'oci://registry.example.com/plugin:1.0!my-plugin',
          disabled: false,
        },
      ],
      main: [
        {
          package: 'oci://registry.example.com/plugin:{{inherit}}',
          disabled: true,
        },
      ],
      expectDisabled: true,
    },
    {
      name: 'cross-form: explicit-path include disabled, path-less main enables → not disabled',
      include: [
        {
          package: 'oci://registry.example.com/plugin:1.0!my-plugin',
          disabled: true,
        },
      ],
      main: [
        {
          package: 'oci://registry.example.com/plugin:{{inherit}}',
          disabled: false,
        },
      ],
      expectDisabled: false,
    },
    {
      name: 'cross-registry: include enabled, explicit-version main disables → disabled by name',
      include: [
        {
          package: 'oci://registry.redhat.io/rhdh/plugin:1.0',
          disabled: false,
        },
      ],
      main: [
        {
          package: 'oci://ghcr.io/example/plugin:2.0',
          disabled: true,
        },
      ],
      expectDisabled: true,
    },
    {
      name: 'cross-registry: disabled include, main inherit re-enables → enabled by name',
      include: [
        {
          package: 'oci://registry.redhat.io/rhdh/plugin:1.0',
          disabled: true,
        },
      ],
      main: [
        {
          package: 'oci://ghcr.io/example/plugin:{{inherit}}',
          disabled: false,
        },
      ],
      expectDisabled: false,
    },
  ];

  it.each(cases)('$name', ({ include, main, expectDisabled }) => {
    const result = preMergeOciDisabledState(
      [['include.yaml', include]],
      main,
      'main.yaml',
    );
    expect(result.has('plugin')).toBe(expectDisabled);
  });
});

describe('preMergeOciDisabledState — same-level duplicates', () => {
  it('rejects duplicate disabled names before filtering can hide them', () => {
    const first = 'oci://registry.redhat.io/rhdh/plugin:1.0!first-path';
    const second = 'oci://ghcr.io/example/plugin:2.0!second-path';
    let thrown: unknown;
    try {
      preMergeOciDisabledState(
        [
          ['catalog-a.yaml', [{ package: first, disabled: true }]],
          ['catalog-b.yaml', [{ package: second, disabled: true }]],
        ],
        [],
        'main.yaml',
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InstallException);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain(first);
    expect(message).toContain('catalog-a.yaml');
    expect(message).toContain(second);
    expect(message).toContain('catalog-b.yaml');
    expect(message).toContain("the plugin name 'plugin'");
  });

  it('throws on duplicate enabled entries at the same level', () => {
    const include: PluginSpec[] = [
      { package: 'oci://registry.example.com/plugin:1.0!a' },
      { package: 'oci://registry.example.com/plugin:1.0!a' },
    ];
    expect(() =>
      preMergeOciDisabledState([['include.yaml', include]], [], 'main.yaml'),
    ).toThrow(/Duplicate OCI plugin configurations/);
  });

  it('rejects multiple plugin paths from one image because identity is the image name', () => {
    const include: PluginSpec[] = [
      { package: 'oci://registry.example.com/plugin:1.0!pluginA' },
      { package: 'oci://registry.example.com/plugin:1.0!pluginB' },
    ];
    expect(() =>
      preMergeOciDisabledState([['include.yaml', include]], [], 'main.yaml'),
    ).toThrow(/both resolve to the plugin name 'plugin'/);
  });
});

describe('preMergeOciDisabledState — invalid OCI strings', () => {
  it('warns and skips when an invalid OCI string is disabled', () => {
    const warn = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const main: PluginSpec[] = [
        { package: 'oci://not a valid spec', disabled: true },
      ];
      const result = preMergeOciDisabledState([], main, 'main.yaml');
      expect(result.size).toBe(0);
      const out = warn.mock.calls.map(args => String(args[0])).join('\n');
      expect(out).toMatch(
        /WARNING: Skipping disabled OCI plugin with invalid format/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('throws when an invalid OCI string is enabled', () => {
    const main: PluginSpec[] = [{ package: 'oci://not a valid spec' }];
    expect(() => preMergeOciDisabledState([], main, 'main.yaml')).toThrow(
      InstallException,
    );
  });

  it('does not accept a malformed tag merely because it contains the inherit marker', () => {
    const pkg = 'oci://ghcr.io/example/plugin:{{inherit}}junk!plugin';
    expect(() =>
      preMergeOciDisabledState([], [{ package: pkg }], 'main.yaml'),
    ).toThrow(`oci package '${pkg}' is not in the expected format`);
  });
});

describe('filterDisabledOciPlugins', () => {
  it('removes plugins whose name is in the disabled set', () => {
    const plugins: PluginSpec[] = [
      { package: 'oci://registry.example.com/plugin:1.0!a' },
      { package: 'oci://other.example.com/other-plugin:2.0!b' },
    ];
    const disabled = new Set(['plugin']);
    const out = filterDisabledOciPlugins(plugins, disabled);
    expect(out.map(p => p.package)).toEqual([
      'oci://other.example.com/other-plugin:2.0!b',
    ]);
  });

  it('removes invalid OCI entries that are marked disabled, keeps invalid-enabled ones (caller will surface them later)', () => {
    const plugins: PluginSpec[] = [
      { package: 'oci://bad spec', disabled: true },
      { package: 'oci://also bad' },
    ];
    const out = filterDisabledOciPlugins(plugins, new Set());
    expect(out.map(p => p.package)).toEqual(['oci://also bad']);
  });

  it('passes non-OCI entries through unchanged', () => {
    const plugins: PluginSpec[] = [
      { package: '@scope/pkg@1.0.0' },
      { package: './local-plugin' },
    ];
    const out = filterDisabledOciPlugins(plugins, new Set(['plugin']));
    expect(out).toHaveLength(2);
  });

  it('removes invalid OCI entries that are marked enabled: false', () => {
    const plugins: PluginSpec[] = [
      { package: 'oci://bad spec', enabled: false },
      { package: 'oci://also bad' },
    ];
    const out = filterDisabledOciPlugins(plugins, new Set());
    expect(out.map(p => p.package)).toEqual(['oci://also bad']);
  });
});

describe('preMergeOciDisabledState — enabled field', () => {
  it('enabled: false in main disables the plugin name', () => {
    const include: PluginSpec[] = [
      { package: 'oci://registry.example.com/plugin:1.0', enabled: true },
    ];
    const main: PluginSpec[] = [
      {
        package: 'oci://registry.example.com/plugin:{{inherit}}',
        enabled: false,
      },
    ];
    const result = preMergeOciDisabledState(
      [['include.yaml', include]],
      main,
      'main.yaml',
    );
    expect(result.has('plugin')).toBe(true);
  });

  it('enabled: true in main re-enables a disabled include', () => {
    const include: PluginSpec[] = [
      { package: 'oci://registry.example.com/plugin:1.0', enabled: false },
    ];
    const main: PluginSpec[] = [
      {
        package: 'oci://registry.example.com/plugin:{{inherit}}',
        enabled: true,
      },
    ];
    const result = preMergeOciDisabledState(
      [['include.yaml', include]],
      main,
      'main.yaml',
    );
    expect(result.has('plugin')).toBe(false);
  });

  it('enabled takes precedence when both enabled and disabled are set', () => {
    const main: PluginSpec[] = [
      {
        package: 'oci://registry.example.com/plugin:1.0',
        enabled: true,
        disabled: true,
      },
    ];
    const result = preMergeOciDisabledState([], main, 'main.yaml');
    expect(result.has('plugin')).toBe(false);
  });
});
