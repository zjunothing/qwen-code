/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { WorkspaceMismatchError } from './acp-session-bridge.js';
import {
  WorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';

// The registry only reads `key` / `isPrimary`; the service handles are
// opaque to it, so synthetic runtimes are enough for these tests.
const makeRuntime = (key: string, isPrimary: boolean): WorkspaceRuntime =>
  ({ key, isPrimary }) as unknown as WorkspaceRuntime;

const PRIMARY = '/work/bound';
const SECONDARY = '/work/other';

describe('WorkspaceRegistry', () => {
  it('requires exactly one primary runtime', () => {
    expect(() => new WorkspaceRegistry([makeRuntime(PRIMARY, false)])).toThrow(
      /requires a primary runtime/,
    );
    expect(
      () =>
        new WorkspaceRegistry([
          makeRuntime(PRIMARY, true),
          makeRuntime(SECONDARY, true),
        ]),
    ).toThrow(/exactly one primary/);
  });

  it('rejects duplicate workspace keys', () => {
    expect(
      () =>
        new WorkspaceRegistry([
          makeRuntime(PRIMARY, true),
          makeRuntime(PRIMARY, false),
        ]),
    ).toThrow(/duplicate workspace key/);
  });

  it('resolves the primary for a missing selector (legacy routes)', () => {
    const registry = new WorkspaceRegistry([makeRuntime(PRIMARY, true)]);
    expect(registry.resolveWorkspace(undefined).key).toBe(PRIMARY);
  });

  it('resolves registered workspaces, canonicalizing the selector', () => {
    const registry = new WorkspaceRegistry([
      makeRuntime(PRIMARY, true),
      makeRuntime(SECONDARY, false),
    ]);
    expect(registry.resolveWorkspace(SECONDARY).key).toBe(SECONDARY);
    // Non-canonical spelling of a registered path still resolves.
    expect(registry.resolveRequiredWorkspace('/work/x/../other').key).toBe(
      SECONDARY,
    );
  });

  it('throws WorkspaceMismatchError for an unregistered workspace', () => {
    const registry = new WorkspaceRegistry([makeRuntime(PRIMARY, true)]);
    expect(() => registry.resolveRequiredWorkspace('/somewhere/else')).toThrow(
      WorkspaceMismatchError,
    );
  });

  it('lists every registered runtime', () => {
    const registry = new WorkspaceRegistry([
      makeRuntime(PRIMARY, true),
      makeRuntime(SECONDARY, false),
    ]);
    expect(registry.list().map((r) => r.key)).toEqual([PRIMARY, SECONDARY]);
  });

  it('tracks session ownership through note/resolve/forget', () => {
    const registry = new WorkspaceRegistry([
      makeRuntime(PRIMARY, true),
      makeRuntime(SECONDARY, false),
    ]);
    expect(registry.resolveSession('s1')).toBeUndefined();

    registry.noteSession('s1', SECONDARY);
    expect(registry.resolveSession('s1')?.key).toBe(SECONDARY);

    registry.forgetSession('s1');
    expect(registry.resolveSession('s1')).toBeUndefined();
  });

  it('refuses to note a session for an unregistered workspace', () => {
    const registry = new WorkspaceRegistry([makeRuntime(PRIMARY, true)]);
    expect(() => registry.noteSession('s1', '/somewhere/else')).toThrow(
      /unregistered workspace/,
    );
  });
});
