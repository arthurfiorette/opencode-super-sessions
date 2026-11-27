import type { ServerRef } from '@opencode/plugin/gui';
import {
  type Accessor,
  createMemo,
  createSelector,
  getOwner,
  type Owner,
  runWithOwner
} from 'solid-js';
import { type ProjectLook, projectLook } from '../host/gui.js';
import type { LocalProject } from './project-avatar.js';

// Project avatars for list rows, one object per project for as long as the project's look stays
// the same. A list draws a row per session, and a route change or a publish of the lists must not
// look each row's project up again: on a real machine that cost about 440 ms per session switch.

/** A server's synced project, as `data.project.list()` returns it. */
type SyncedProject = NonNullable<
  ReturnType<NonNullable<ServerRef['data']['project']>['list']>
>[number];

/** The routed session's project with the user's local name and icon, and its server. */
export interface RoutedProject extends LocalProject {
  readonly server: string;
}

/** Whether two looks draw the same avatar. */
function sameLook(a: ProjectLook, b: ProjectLook): boolean {
  return (
    a.name === b.name &&
    a.root === b.root &&
    a.initial === b.initial &&
    a.src === b.src &&
    a.variant === b.variant
  );
}

/**
 * The looks of every project a view's rows draw. Call it under the view's owner; the memos it
 * makes on first use live as long as that owner. Each server's project list is read into one map
 * per change of the list, and each project's look is one memo, so a row reads a cached object.
 * `routed` is the routed session's project: only the memo of that project reads it, through a
 * selector, so a route change re-runs at most the old and the new routed project's look.
 */
export function createProjectLooks(routed: Accessor<RoutedProject | undefined>) {
  const owner: Owner | null = getOwner();
  const routedKey = createMemo(() => {
    const project = routed();
    return project === undefined ? undefined : `${project.server}\n${project.id}`;
  });
  const isRouted = createSelector(routedKey);
  const catalogs = new Map<string, Accessor<ReadonlyMap<string, SyncedProject>>>();
  const looks = new Map<string, Accessor<ProjectLook>>();

  /** The server's synced projects by id, read again only when its list changes. */
  const catalog = (server: ServerRef) => {
    let found = catalogs.get(server.id);
    if (found === undefined) {
      found = runWithOwner(owner, () =>
        createMemo(
          () => new Map((server.data.project?.list() ?? []).map((project) => [project.id, project]))
        )
      ) as Accessor<ReadonlyMap<string, SyncedProject>>;
      catalogs.set(server.id, found);
    }
    return found;
  };

  return {
    /**
     * The look of a session's project on `server`. `directory` names a project the server has not
     * synced, or the global project of sessions outside one, which each directory stands for.
     */
    of(server: ServerRef, projectID: string, directory: string): ProjectLook {
      const key = `${server.id}\n${projectID === 'global' ? `directory:${directory}` : projectID}`;
      let look = looks.get(key);
      if (look === undefined) {
        const projects = catalog(server);
        const routedID = `${server.id}\n${projectID}`;
        look = runWithOwner(owner, () =>
          createMemo(
            () => {
              const stored = projectID === 'global' ? undefined : projects().get(projectID);
              const local = isRouted(routedID) ? routed() : undefined;
              return projectLook({
                id: projectID,
                name: local?.name ?? stored?.name,
                root: stored?.canonical ?? directory,
                icon: local?.icon ?? stored?.icon
              });
            },
            undefined,
            { equals: sameLook }
          )
        ) as Accessor<ProjectLook>;
        looks.set(key, look);
      }
      // A row that reads it tracks only this memo, which keeps its object while the look holds.
      return look();
    }
  };
}

export type ProjectLooks = ReturnType<typeof createProjectLooks>;
