import { usePlugin } from '@opencode/plugin/gui';
import { For, Show } from 'solid-js';
import { MACHINE_ICON } from '../../host/gui.js';
import { ProjectAvatar } from '../project-avatar.js';
import type { RailMachineInfo, RailSection, RailTile } from './rail.js';

// The project rail down the browser's left edge: All, then each machine's name over its tiles
// when the app lists more than one, with each project in the app's avatar, its running count and
// unread dot.

/** Props of {@link ProjectRail}. */
export interface ProjectRailProps {
  readonly sections: readonly RailSection[];
  /** The picked tile's key. */
  readonly picked: string | undefined;
  readonly onPick: (tile: RailTile) => void;
}

/**
 * A machine name short enough for the rail: a hostname without its domain, such as
 * `Arthurs-MacBook-Pro` for `Arthurs-MacBook-Pro.local`. An address keeps its dots, which are
 * its name. The stylesheet cuts what is still too wide.
 */
export function shortMachineName(name: string): string {
  if (/^[\d.:[\]]+$/.test(name) || !name.includes('.')) return name;
  return name.slice(0, name.indexOf('.')) || name;
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
    const parts = [tile.place === undefined ? name : `${name} · ${tile.place}`];
    if (tile.running > 0) parts.push(ctx.t('browser.rail.running', { count: tile.running }));
    if (tile.unread) parts.push(ctx.t('browser.rail.unread'));
    return parts.join(', ');
  };
  return (
    <nav class="ss-rail" aria-label={ctx.t('browser.rail')}>
      <For each={props.sections}>
        {(section) => (
          <>
            <Show when={section.machine}>{(machine) => <MachineHeader machine={machine()} />}</Show>
            <For each={section.tiles}>
              {(tile) => (
                <ctx.ui.Tooltip value={label(tile)}>
                  <button
                    type="button"
                    class="ss-rail-tile"
                    classList={{ 'ss-rail-all': tile.look === undefined }}
                    aria-label={label(tile)}
                    aria-pressed={props.picked === tile.key}
                    data-tile={tile.tile}
                    data-server={tile.server}
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
          </>
        )}
      </For>
    </nav>
  );
}

/**
 * A machine's divider on the rail, as the sidebar heads a machine's group: the server icon and
 * the machine's name, shortened, with the full name in the tooltip, and the machine muted while
 * it is not connected.
 */
function MachineHeader(props: { machine: RailMachineInfo }) {
  const ctx = usePlugin();
  const title = () =>
    props.machine.connected
      ? props.machine.name
      : ctx.t('browser.machine.offlineTitle', { machine: props.machine.name });
  return (
    <ctx.ui.Tooltip value={title()}>
      <div
        class="ss-rail-machine"
        data-machine={props.machine.id}
        data-connected={props.machine.connected ? 'true' : 'false'}
      >
        <ctx.ui.Icon name={MACHINE_ICON} />
        <span class="ss-rail-machine-name">{shortMachineName(props.machine.name)}</span>
      </div>
    </ctx.ui.Tooltip>
  );
}
