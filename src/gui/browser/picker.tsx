import { type ServerRef, usePlugin } from '@opencode/plugin/gui';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack
} from 'solid-js';
import { ADD_PROJECT, activitySpinner, homePath, SERVER_CHIP } from '../../host/gui.js';
import { ProjectAvatar } from '../project-avatar.js';
import { searchProjects, splitRecent } from './project-search.js';
import { ALL_KEY, type ProjectEntry } from './projects.js';

// The browser's project picker: the Settings server switcher's trigger in the dialog's header,
// and the app's "Search projects" dialog over the browser (PROJECT_SEARCH in src/host/gui.ts):
// a search field, All projects, the recent projects, an "Other projects" row for the rest, and
// "Add project", which runs the app's own folder picker (ADD_PROJECT).

/** Props of {@link ProjectPicker}. */
export interface ProjectPickerProps {
  /** Every machine's projects in one list, newest activity first. */
  readonly projects: readonly ProjectEntry[];
  /** The picked project's key, `all` for every project. */
  readonly picked: string | undefined;
  /** Picks a project, or every project for undefined. */
  readonly onPick: (project: ProjectEntry | undefined) => void;
  /** The connected machines a new project can be added on, the app's own first. */
  readonly servers: readonly ServerRef[];
  /** Adds a project on a machine through the app's folder picker. */
  readonly onAdd: (server: ServerRef) => void;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** Runs after the picker closed without adding a project, to give the browser its focus back. */
  readonly onClosed: () => void;
}

/**
 * The trigger, and the picker's dialog while `open` holds. The dialog opens above the browser in
 * the app's dialog stack, which closes only the top one on escape and gives the focus back to
 * what had it; it closes with the browser too.
 */
export function ProjectPicker(props: ProjectPickerProps) {
  const ctx = usePlugin();
  const current = () => props.projects.find((project) => project.key === props.picked);

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        let adding = false;
        const handle = untrack(() =>
          ctx.dialogs.open((dialog) => {
            onCleanup(() => {
              props.setOpen(false);
              if (!adding) queueMicrotask(props.onClosed);
            });
            return (
              <ctx.ui.Dialog title={ctx.t('browser.picker.search')} size="large">
                <ProjectSearch
                  projects={props.projects}
                  picked={props.picked}
                  servers={props.servers}
                  onPick={(project) => {
                    dialog.close();
                    props.onPick(project);
                  }}
                  onAdd={(server) => {
                    adding = true;
                    dialog.close();
                    props.onAdd(server);
                  }}
                  close={dialog.close}
                />
              </ctx.ui.Dialog>
            );
          })
        );
        // A close from the trigger, or the browser closing, takes the picker with it.
        onCleanup(handle.close);
      }
    )
  );

  return (
    <div class="ss-picker">
      <button
        type="button"
        data-component="button-v2"
        data-size="small"
        data-variant="outline"
        data-expanded={props.open ? '' : undefined}
        class="ss-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={props.open}
        aria-label={ctx.t('browser.picker')}
        data-picked={props.picked}
        onClick={() => props.setOpen(!props.open)}
      >
        <span class="ss-picker-icon">
          <Show when={current()} fallback={<ctx.ui.Icon name="workspace" />}>
            {(project) => <ProjectAvatar look={project().look} />}
          </Show>
        </span>
        <span class="ss-picker-name">{current()?.look.name ?? ctx.t('browser.picker.all')}</span>
        <ctx.ui.Icon name="chevron-down" class="ss-picker-chevron" />
      </button>
    </div>
  );
}

/** One row of the picker. */
type Row =
  | { readonly id: string; readonly type: 'all' }
  | { readonly id: string; readonly type: 'project'; readonly project: ProjectEntry }
  | { readonly id: string; readonly type: 'other'; readonly count: number }
  | { readonly id: string; readonly type: 'add' }
  | { readonly id: string; readonly type: 'server'; readonly server: ServerRef };

/** Props of {@link ProjectSearch}. */
interface ProjectSearchProps {
  readonly projects: readonly ProjectEntry[];
  readonly picked: string | undefined;
  readonly servers: readonly ServerRef[];
  readonly onPick: (project: ProjectEntry | undefined) => void;
  readonly onAdd: (server: ServerRef) => void;
  readonly close: () => void;
}

/** Whether a key event is the app's "Add project" chord, `mod+o` (ADD_PROJECT). */
function isAddChord(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'o'
  );
}

/** A project's row. */
function projectRow(project: ProjectEntry): Row {
  return { id: project.key, type: 'project', project };
}

/** The "Add project" row. */
const ADD_ROW: Row = { id: 'add', type: 'add' };

/**
 * The picker's content. Without a query: All, the recent projects, then "Other projects" until
 * chosen, which lists the rest by name in place; with one, every matching project, best match
 * first. "Add project" ends both, and with more than one machine it lists the machines first, as
 * the app does. The search field keeps the focus and names the active row, so the rows are no tab
 * stops; up and down move, enter chooses and escape closes, or goes back from the machines.
 */
function ProjectSearch(props: ProjectSearchProps) {
  const ctx = usePlugin();
  const [query, setQuery] = createSignal('');
  const [step, setStep] = createSignal<'projects' | 'servers'>('projects');
  const split = createMemo(() => splitRecent(props.projects));
  // A pick among the rest opens with them listed, so its row and check show.
  const [expanded, setExpanded] = createSignal(
    untrack(() => split().others.some((project) => project.key === props.picked))
  );

  const rows = createMemo((): Row[] => {
    if (step() === 'servers') {
      const needle = query().trim().toLowerCase();
      return props.servers
        .filter((server) => server.name.toLowerCase().includes(needle))
        .map((server) => ({ id: `server:${server.id}`, type: 'server', server }));
    }
    const adds = props.servers.length > 0 ? [ADD_ROW] : [];
    if (query().trim() !== '') {
      return [...searchProjects(props.projects, query()).map(projectRow), ...adds];
    }
    const { recent, others } = split();
    const rest: Row[] = expanded()
      ? others.map(projectRow)
      : others.length > 0
        ? [{ id: 'other', type: 'other', count: others.length }]
        : [];
    return [{ id: ALL_KEY, type: 'all' }, ...recent.map(projectRow), ...rest, ...adds];
  });
  /** The first of the rest, which the "Other projects" heading sits over once they show. */
  const firstOther = () =>
    expanded() && query().trim() === '' && step() === 'projects'
      ? split().others[0]?.key
      : undefined;

  // The active row: the picked one at first, then the first row of every new list, as the app's
  // typeahead starts each list on its first row.
  const [active, setActive] = createSignal<string | undefined>(untrack(() => props.picked));
  const activeRow = () => rows().find((row) => row.id === active()) ?? rows()[0];

  let input: HTMLInputElement | undefined;
  let results: HTMLDivElement | undefined;
  /** Scrolls the active row into view once it is drawn. */
  const reveal = () =>
    queueMicrotask(() =>
      results?.querySelector('[data-active]')?.scrollIntoView?.({ block: 'nearest' })
    );
  onMount(() => {
    input?.focus();
    reveal();
  });

  const choose = (row: Row | undefined) => {
    if (row === undefined) return;
    if (row.type === 'all') props.onPick(undefined);
    else if (row.type === 'project') props.onPick(row.project);
    else if (row.type === 'server') props.onAdd(row.server);
    else if (row.type === 'other') {
      setExpanded(true);
      setActive(split().others[0]?.key);
      reveal();
    } else {
      const [only, ...more] = props.servers;
      if (only !== undefined && more.length === 0) props.onAdd(only);
      else if (only !== undefined) {
        setStep('servers');
        setQuery('');
        setActive(undefined);
      }
    }
  };
  /** Moves the active row by `delta`, clamped to the list. */
  const move = (delta: number) => {
    const list = rows();
    const index = list.findIndex((row) => row.id === activeRow()?.id);
    setActive(list[Math.min(list.length - 1, Math.max(0, index + delta))]?.id);
    reveal();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    let handled = true;
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'Enter') choose(activeRow());
    else if (isAddChord(event)) choose(ADD_ROW);
    else if (event.key === 'Escape') {
      // The app's dialog stack takes escape first and closes the picker, unless the field owns
      // it, as it does on the machines, where escape goes back.
      if (step() === 'servers') {
        setStep('projects');
        setQuery('');
        setActive(ADD_ROW.id);
      } else props.close();
    } else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const placeholder = () =>
    ctx.t(step() === 'servers' ? 'browser.picker.servers' : 'browser.picker.search');

  return (
    <div class="ss-project-search">
      <div class="ss-project-search-field">
        <div
          data-component="text-input-v2"
          data-appearance="large"
          data-surface="base"
          data-leading-icon=""
        >
          <div data-slot="text-input-v2-value">
            <span data-slot="text-input-v2-leading-icon">
              <ctx.ui.Icon name="magnifying-glass" />
            </span>
            <input
              ref={input}
              data-slot="text-input-v2-input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="ss-project-search-results"
              aria-activedescendant={rowID(activeRow()?.id)}
              aria-label={placeholder()}
              placeholder={placeholder()}
              data-owns-escape={step() === 'servers' ? '' : undefined}
              value={query()}
              spellcheck={false}
              autocomplete="off"
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setActive(undefined);
              }}
              on:keydown={onKeyDown}
            />
          </div>
        </div>
      </div>
      <div class="ss-project-search-divider" aria-hidden="true" />
      <div
        ref={results}
        id="ss-project-search-results"
        class="ss-project-search-results"
        role="listbox"
        aria-label={ctx.t('browser.picker')}
      >
        <Show
          when={rows().length > 0}
          fallback={<p class="ss-project-search-empty">{ctx.t('browser.picker.empty')}</p>}
        >
          <For each={rows()}>
            {(row, index) => (
              <>
                <Show when={row.id === firstOther()}>
                  <div class="ss-project-search-title">{ctx.t('browser.picker.other')}</div>
                </Show>
                <Show when={row.type === 'add' && index() > 0}>
                  <hr class="ss-project-search-action-divider" />
                </Show>
                <PickerRow
                  row={row}
                  active={activeRow()?.id === row.id}
                  checked={row.id === props.picked}
                  onHover={() => setActive(row.id)}
                  onChoose={() => choose(row)}
                />
              </>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

/** The DOM id of a row, for `aria-activedescendant`. */
function rowID(key: string | undefined): string | undefined {
  return key === undefined ? undefined : `ss-picker-${key.replace(/[^\w-]/g, '_')}`;
}

/** Props of {@link PickerRow}. */
interface PickerRowProps {
  readonly row: Row;
  readonly active: boolean;
  readonly checked: boolean;
  readonly onHover: () => void;
  readonly onChoose: () => void;
}

/**
 * A row as the app's "Search projects" dialog draws it: a project's avatar, name, the server chip
 * of another machine and its full path, with what runs or waits in it and the check of the picked
 * one at the end; or All, "Other projects" with its count, "Add project" with its keybind, or a
 * machine to add a project on.
 */
function PickerRow(props: PickerRowProps) {
  const ctx = usePlugin();
  const project = () => (props.row.type === 'project' ? props.row.project : undefined);
  const server = () => (props.row.type === 'server' ? props.row.server : undefined);
  return (
    <button
      type="button"
      id={rowID(props.row.id)}
      class="ss-picker-item"
      classList={{ 'ss-picker-action': props.row.type === 'other' || props.row.type === 'add' }}
      role="option"
      tabIndex={-1}
      aria-selected={props.active}
      data-active={props.active ? '' : undefined}
      data-option={props.row.id}
      onMouseMove={(event) => {
        // A row the keys scrolled under a still pointer leaves the keys' row active.
        if (event.movementX !== 0 || event.movementY !== 0) props.onHover();
      }}
      // The field keeps the focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onChoose()}
    >
      <span class="ss-picker-item-main">
        <Switch>
          <Match when={project()}>{(entry) => <ProjectLine project={entry()} />}</Match>
          <Match when={server()}>
            {(machine) => (
              <>
                <ctx.ui.Icon
                  name={machine().builtin || machine().local ? 'monitor' : SERVER_CHIP.icon}
                  class="ss-picker-row-icon"
                />
                <span class="ss-picker-item-name">{machine().name}</span>
              </>
            )}
          </Match>
          <Match when={props.row.type === 'all'}>
            <ctx.ui.Icon name="workspace" class="ss-picker-row-icon" />
            <span class="ss-picker-item-name">{ctx.t('browser.picker.all')}</span>
          </Match>
          <Match when={props.row.type === 'other' ? props.row : undefined}>
            {(row) => (
              <>
                <ctx.ui.Icon name="menu" class="ss-picker-row-icon" />
                <span class="ss-picker-item-name">{ctx.t('browser.picker.other')}</span>
                <span class="ss-picker-count">{row().count}</span>
              </>
            )}
          </Match>
          <Match when={props.row.type === 'add'}>
            <ctx.ui.Icon name="plus" class="ss-picker-row-icon" />
            <span class="ss-picker-item-name">{ctx.t('browser.picker.add')}</span>
          </Match>
        </Switch>
      </span>
      <Show when={props.row.type === 'add'}>
        <ctx.ui.Keybind keys={ctx.keybinds.keys(ADD_PROJECT.chord)} class="ss-picker-keybind" />
      </Show>
      <Show when={project()}>
        {(entry) => (
          <>
            <Show when={entry().running > 0}>
              <span
                class="ss-picker-running"
                title={ctx.t('browser.projects.running', { count: entry().running })}
              >
                <span {...activitySpinner(12)} />
                {entry().running}
              </span>
            </Show>
            <Show when={entry().unread}>
              <span class="ss-row-dot" role="img" aria-label={ctx.t('browser.unread')} />
            </Show>
          </>
        )}
      </Show>
      <Show when={props.checked}>
        <ctx.ui.Icon name="check" class="ss-picker-check" />
      </Show>
    </button>
  );
}

/** A project's avatar, name, server chip and full path, with `~` for the home directory. */
function ProjectLine(props: { readonly project: ProjectEntry }) {
  const ctx = usePlugin();
  return (
    <>
      <ProjectAvatar look={props.project.look} class="ss-picker-avatar" />
      <span class="ss-picker-item-text">
        <span class="ss-picker-item-head">
          <span class="ss-picker-item-name">{props.project.look.name}</span>
          <Show when={props.project.machine}>
            {(name) => (
              <span
                data-component="tag"
                data-appearance="compact"
                data-variant="subtle"
                class="ss-server-chip"
                data-machine-mark={name()}
                title={name()}
              >
                <ctx.ui.Icon name={SERVER_CHIP.icon} />
                <span>{name()}</span>
              </span>
            )}
          </Show>
        </span>
        <span class="ss-picker-place" dir="ltr">
          {homePath(props.project.look.root)}
        </span>
      </span>
    </>
  );
}
