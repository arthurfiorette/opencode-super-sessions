import { usePlugin } from '@opencode/plugin/gui';
import { For, Show } from 'solid-js';
import { ProjectAvatar } from '../project-avatar.js';
import type { RailTile } from './rail.js';

// The project rail down the browser's left edge: All, then a tile for each project in the app's
// avatar, with its running count and unread dot.

/** Props of {@link ProjectRail}. */
export interface ProjectRailProps {
  readonly tiles: readonly RailTile[];
  /** The picked tile's key. */
  readonly picked: string | undefined;
  readonly onPick: (tile: RailTile) => void;
}

/**
 * The rail. Each tile is a button that says its project, its running sessions and whether any is
 * unread; the picked one is pressed.
 */
export function ProjectRail(props: ProjectRailProps) {
  const ctx = usePlugin();
  /** What a tile's tooltip and accessible name say. */
  const label = (tile: RailTile) => {
    const name = tile.look?.name ?? ctx.t('browser.rail.all');
    const parts = [name];
    if (tile.running > 0) parts.push(ctx.t('browser.rail.running', { count: tile.running }));
    if (tile.unread) parts.push(ctx.t('browser.rail.unread'));
    return parts.join(', ');
  };
  return (
    <nav class="ss-rail" aria-label={ctx.t('browser.rail')}>
      <For each={props.tiles}>
        {(tile) => (
          <ctx.ui.Tooltip value={label(tile)}>
            <button
              type="button"
              class="ss-rail-tile"
              classList={{ 'ss-rail-all': tile.look === undefined }}
              aria-label={label(tile)}
              aria-pressed={props.picked === tile.key}
              data-tile={tile.key}
              onClick={() => props.onPick(tile)}
            >
              <Show
                when={tile.look}
                fallback={
                  <span class="ss-rail-face">
                    <ctx.ui.Icon name="workspace" />
                  </span>
                }
              >
                {(look) => <ProjectAvatar look={look()} />}
              </Show>
              <Show when={tile.running > 0}>
                <span class="ss-rail-running" data-running={tile.running}>
                  {tile.running}
                </span>
              </Show>
              <Show when={tile.unread}>
                <span class="ss-rail-unread" />
              </Show>
            </button>
          </ctx.ui.Tooltip>
        )}
      </For>
    </nav>
  );
}
