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
import { log } from './log';
import { type OciImageCache } from './image-cache';
import { extractPluginName } from './plugin-name';
import { OCI_PROTO } from './protocols';
import { RECOGNIZED_ALGORITHMS } from './types';

const OCI_PATTERN = [
  '^(',
  escape(OCI_PROTO),
  String.raw`[^\s/:@]+`, // registry host
  String.raw`(?::\d+)?`, // optional port
  String.raw`(?:/[^\s:@]+)+`, // at least one path segment
  ')',
  String.raw`(?::([^\s!@:]+)`, // tag
  '|',
  String.raw`@((?:sha256|sha512|blake3):[^\s!@:]+))`, // or digest
  String.raw`(?:!([^\s]+))?$`, // optional !<plugin-path>
].join('');

export const OCI_REGEX = new RegExp(OCI_PATTERN);

export type ParsedOciKey = {
  /**
   * Name-based identifier: the last OCI path segment (the plugin name), with
   * the registry host, namespace, tag/digest, and `!plugin-path` stripped.
   *
   * For example `oci://ghcr.io/org/backstage-plugin-catalog:1.0!path` and
   * `oci://registry.redhat.io/rhdh/backstage-plugin-catalog@sha256:abc!path`
   * both resolve to `backstage-plugin-catalog`, so `{{inherit}}` matching and
   * cross-level overrides are host- and namespace-agnostic — aligning with the
   * operator's `DynaPlugin.Name()`. The concrete registry is preserved on
   * `plugin.package`, which is what install pulls from.
   */
  pluginKey: string;
  /** Tag (e.g. `1.2.3`) or digest (`sha256:...`). */
  version: string;
  /** True when tag was `{{inherit}}` (version to be resolved from an included config). */
  inherit: boolean;
  /**
   * Resolved plugin path — explicit `!<path>`, auto-detected from the image's
   * `io.backstage.dynamic-packages` annotation, or `null` when `{{inherit}}`
   * is used without a path (the merger resolves it later).
   */
  resolvedPath: string | null;
};

/**
 * Parse an `oci://...` package spec. Matches fast.py and the original
 * `OciPackageMerger.parse_plugin_key`. Calls into `imageCache.getPluginPaths`
 * to auto-detect single-plugin images when the `!path` suffix is omitted.
 */
export async function ociPluginKey(
  pkg: string,
  imageCache?: OciImageCache,
): Promise<ParsedOciKey> {
  const m = OCI_REGEX.exec(pkg);
  if (!m) {
    throw new InstallException(
      `oci package '${pkg}' is not in the expected format '${OCI_PROTO}<registry>:<tag>' ` +
        `or '${OCI_PROTO}<registry>@<algo>:<digest>' (optionally followed by '!<path>') ` +
        `where <registry> may include a port (e.g. host:5000/path) ` +
        `and <algo> is one of ${RECOGNIZED_ALGORITHMS.join(', ')}`,
    );
  }

  const registry = m[1] as string;
  const tag = m[2];
  const digest = m[3];
  let path = m[4] ?? null;

  const version = (tag ?? digest) as string;
  const inherit = tag === '{{inherit}}' && digest === undefined;

  // The matching key is the plugin name (last OCI path segment), ignoring the
  // registry host and namespace so the same plugin published to different
  // registries resolves to the same key. `registry` (group 1) never carries a
  // tag or digest, so this yields just the image name.
  const pluginKey = extractPluginName(registry);
  if (!pluginKey) {
    throw new InstallException(
      `Cannot determine the plugin name (last OCI path segment) for '${pkg}'`,
    );
  }

  if (inherit && !path) {
    // The merger will match against an earlier included plugin of the same name.
    return { pluginKey, version, inherit, resolvedPath: null };
  }

  if (!path) {
    path = await autoDetectPluginPath(
      pkg,
      registry,
      version,
      tag !== undefined,
      imageCache,
    );
  }

  return {
    pluginKey,
    version,
    inherit,
    resolvedPath: path,
  };
}

async function autoDetectPluginPath(
  pkg: string,
  registry: string,
  version: string,
  isTag: boolean,
  imageCache: OciImageCache | undefined,
): Promise<string> {
  if (!imageCache) {
    throw new InstallException(
      `Cannot auto-detect plugin path for ${pkg}: no image cache provided`,
    );
  }
  const fullImage = isTag ? `${registry}:${version}` : `${registry}@${version}`;
  log(
    `\n======= No plugin path specified for ${fullImage}, auto-detecting from OCI manifest`,
  );
  const paths = await imageCache.getPluginPaths(fullImage);
  if (paths.length === 0) {
    throw new InstallException(
      `No plugins found in OCI image ${fullImage}. ` +
        `The image might not contain the 'io.backstage.dynamic-packages' annotation. ` +
        `Please ensure it was packaged using the @red-hat-developer-hub/cli plugin package command.`,
    );
  }
  if (paths.length > 1) {
    const formatted = paths.map(p => `  - ${p}`).join('\n');
    throw new InstallException(
      `Multiple plugins found in OCI image ${fullImage}:\n${formatted}\n` +
        `Please specify which plugin to install using the syntax: ${fullImage}!<plugin-name>`,
    );
  }
  const resolved = paths[0] as string;
  log(
    `\n======= Auto-resolving OCI package ${fullImage} to use plugin path: ${resolved}`,
  );
  return resolved;
}

/**
 * Synchronous parse for the disable-pre-merge pass. Returns `null` when the
 * package does not match the expected OCI grammar — callers decide how to
 * react (warn-and-skip when the entry is disabled, throw when it is enabled).
 * Mirrors the `match.group(1)` / `match.group(4)` access pattern used by
 * `pre_merge_oci_disabled_state` in the Python implementation.
 */
export function tryParseOciRegistryAndPath(
  pkg: string,
): { registry: string; path: string | null } | null {
  const m = OCI_REGEX.exec(pkg);
  if (!m) return null;
  return { registry: m[1] as string, path: m[4] ?? null };
}

function escape(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}
