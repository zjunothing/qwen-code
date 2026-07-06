/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  canonicalizeWorkspace,
  WorkspaceMismatchError,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import type { ClientMcpSenderRegistry } from './acp-http/client-mcp-sender-registry.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import type { DaemonWorkspaceService } from './workspace-service/index.js';

/**
 * One workspace's serve-layer service bundle (issue #6378, Phase 1).
 *
 * A runtime owns everything that is scoped to a single bound workspace:
 * the ACP session bridge, the daemon workspace service, the filesystem
 * boundary factory, and the client-MCP sender registry. Today the daemon
 * hosts exactly one runtime (the primary); the multi-workspace phases add
 * additional runtimes behind the same registry without changing what a
 * runtime is.
 */
export interface WorkspaceRuntime {
  /** Canonical workspace path (the registry lookup key). */
  readonly key: string;
  readonly isPrimary: boolean;
  readonly bridge: AcpSessionBridge;
  readonly workspaceService: DaemonWorkspaceService;
  readonly fsFactory: WorkspaceFileSystemFactory;
  readonly clientMcpSenderRegistry: ClientMcpSenderRegistry;
}

/**
 * Registry of workspace runtimes hosted by this daemon process.
 *
 * Phase 1 scope: the registry always holds exactly one runtime (the
 * primary) and exists so routes can resolve "which workspace does this
 * request address?" through one seam instead of a bare `boundWorkspace`
 * string. Selection rules follow the multi-workspace design doc:
 *
 * - `resolveWorkspace(undefined)` → primary (legacy workspace-less routes).
 * - `resolveWorkspace(path)` / `resolveRequiredWorkspace(path)` → the
 *   registered runtime whose key matches the canonicalized input, else
 *   `WorkspaceMismatchError` (the same error the bridge raises today for
 *   a mismatched `POST /session` cwd, so HTTP translation is unchanged).
 *
 * The registry only selects runtimes; it never fans one request out to
 * several workspaces.
 */
export class WorkspaceRegistry {
  readonly primary: WorkspaceRuntime;
  private readonly byKey = new Map<string, WorkspaceRuntime>();
  private readonly sessionOwners = new Map<string, string>();

  constructor(runtimes: readonly WorkspaceRuntime[]) {
    const primary = runtimes.find((r) => r.isPrimary);
    if (!primary) {
      throw new Error('WorkspaceRegistry requires a primary runtime.');
    }
    for (const runtime of runtimes) {
      if (runtime.isPrimary && runtime !== primary) {
        throw new Error(
          'WorkspaceRegistry requires exactly one primary runtime.',
        );
      }
      if (this.byKey.has(runtime.key)) {
        throw new Error(
          `WorkspaceRegistry: duplicate workspace key "${runtime.key}".`,
        );
      }
      this.byKey.set(runtime.key, runtime);
    }
    this.primary = primary;
  }

  list(): readonly WorkspaceRuntime[] {
    return [...this.byKey.values()];
  }

  /**
   * Resolve a workspace selector to a runtime. `undefined` means "the
   * caller sent no selector" and falls back to the primary — the legacy
   * single-workspace contract.
   */
  resolveWorkspace(input: string | undefined): WorkspaceRuntime {
    if (input === undefined) {
      return this.primary;
    }
    return this.resolveRequiredWorkspace(input);
  }

  /** Resolve an explicit workspace selector; unknown → mismatch error. */
  resolveRequiredWorkspace(input: string): WorkspaceRuntime {
    const runtime = this.tryResolveWorkspace(input);
    if (!runtime) {
      throw new WorkspaceMismatchError(this.primary.key, input);
    }
    return runtime;
  }

  /**
   * Non-throwing probe for an explicit workspace selector. Callers that
   * want legacy fallback semantics (unknown path → primary bridge, whose
   * own bound-workspace validation produces today's `workspace_mismatch`)
   * use this instead of overloading `resolveWorkspace`.
   */
  tryResolveWorkspace(input: string): WorkspaceRuntime | undefined {
    return (
      this.byKey.get(input) ?? this.byKey.get(canonicalizeWorkspace(input))
    );
  }

  /** Record which workspace owns a live session id. */
  noteSession(sessionId: string, workspaceKey: string): void {
    if (!this.byKey.has(workspaceKey)) {
      throw new Error(
        `WorkspaceRegistry: cannot note session "${sessionId}" for ` +
          `unregistered workspace "${workspaceKey}".`,
      );
    }
    this.sessionOwners.set(sessionId, workspaceKey);
  }

  forgetSession(sessionId: string): void {
    this.sessionOwners.delete(sessionId);
  }

  /**
   * Find the runtime that owns a session id: noted ownership first, then
   * a scan of each runtime's live sessions (Phase 2a owner resolution per
   * the design doc; the noted index becomes authoritative with the Phase
   * 2b lifecycle hooks). Callers fall back to their existing
   * single-workspace behavior (and ultimately `session_not_found`) when
   * this returns `undefined`.
   */
  resolveSession(sessionId: string): WorkspaceRuntime | undefined {
    const key = this.sessionOwners.get(sessionId);
    if (key !== undefined) {
      return this.byKey.get(key);
    }
    for (const runtime of this.byKey.values()) {
      try {
        // Sync map lookup; throws SessionNotFoundError when the session
        // is not live on this runtime.
        runtime.bridge.getSessionSummary(sessionId);
        return runtime;
      } catch {
        // Not on this runtime — keep scanning.
      }
    }
    return undefined;
  }
}
