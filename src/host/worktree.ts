import type { Plugin } from '@opencode/plugin';

// The worktrees OpenCode knows and how it removes them, as cleanup relies on. Removal has no
// undo, so test/contract checks both against a real host and a real git repository. Line numbers
// refer to the OpenCode repository at v2.2.5.

/** A worktree of a project, as `context.worktree.list` reports it. */
export interface ProjectWorktree {
  directory: string;
  /**
   * The checkout OpenCode discovered the project from: no worktree strategy owns it
   * (packages/core/src/worktree.ts:143 maps a missing strategy to undefined). Cleanup never
   * removes it.
   */
  main: boolean;
}

/** The worktrees of one project, main checkout included. */
export async function projectWorktrees(
  context: Plugin.Context,
  projectID: string
): Promise<ProjectWorktree[]> {
  const entries = await context.worktree.list({ projectID });
  return entries.map((entry) => ({
    directory: entry.directory,
    main: entry.strategy === undefined
  }));
}

/**
 * Removes a worktree without force. The git strategy passes `force` to `git worktree remove`
 * (packages/core/src/worktree/git.ts:25), and git refuses a worktree with modified or untracked
 * files, which backs up the plugin's own status check if a file appears in between.
 */
export function removeWorktree(
  context: Plugin.Context,
  projectID: string,
  directory: string
): Promise<void> {
  return context.worktree.remove({ projectID, directory, force: false });
}
