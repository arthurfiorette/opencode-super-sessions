import { usePlugin } from '@opencode/plugin/gui';
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import { activitySpinner } from '../../host/gui.js';
import { ProjectAvatar } from '../project-avatar.js';
import { ALL_KEY, type ProjectEntry } from './projects.js';
import { MachineMark } from './projects-view.js';

// The browser's project picker: the Settings server switcher's trigger in the dialog's header,
// and a menu of All projects and every machine's projects in the app's menu markup (BUTTON and
// MENU in src/host/gui.ts). `ui.Menu` and `ui.Select` list text and icons only, and each project
// here shows its avatar, its folder, its machine when it is another one, and what runs in it.

/** Props of {@link ProjectPicker}. */
export interface ProjectPickerProps {
  /** Every machine's projects in one list; one that is not connected lists none. */
  readonly projects: readonly ProjectEntry[];
  /** The picked project's key, `all` for every project. */
  readonly picked: string | undefined;
  /** Picks a project, or every project for undefined. */
  readonly onPick: (project: ProjectEntry | undefined) => void;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

/** One row of the menu: All, or a project. */
interface Option {
  readonly key: string;
  readonly project: ProjectEntry | undefined;
}

/**
 * The picker. The menu opens from the trigger or `alt+p`, lists All first, then every machine's
 * projects in one list, and takes up, down, home, end, enter and escape while it has the focus,
 * as the app's menus do.
 */
export function ProjectPicker(props: ProjectPickerProps) {
  const ctx = usePlugin();
  const options = createMemo((): Option[] => [
    { key: ALL_KEY, project: undefined },
    ...props.projects.map((project) => ({ key: project.key, project }))
  ]);
  const current = () => options().find((option) => option.key === props.picked)?.project;
  // The keys' highlight. The pointer's is CSS `:hover` (browser.css): an attribute written on
  // every pointer move restyled the whole dialog, about 14,000 elements and 100 ms a move, while
  // the menu was open in the trace of a 400-session list.
  const [active, setActive] = createSignal<string | undefined>();
  /** The row the pointer is over, where the keys start from after it moved. */
  let hovered: string | undefined;
  /** The pointer took over: the keys' highlight goes, once, and the keys start from its row. */
  const hover = (key: string) => {
    hovered = key;
    if (untrack(active) !== undefined) setActive(undefined);
  };
  let root: HTMLDivElement | undefined;
  let menu: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;

  // Opening highlights the picked row and takes the focus; closing gives it back to the trigger
  // only when the menu had it, so a pick by mouse leaves the focus where the dialog keeps it.
  createEffect(() => {
    if (!props.open) return;
    hovered = undefined;
    setActive(props.picked ?? ALL_KEY);
    queueMicrotask(() => {
      menu?.focus();
      menu?.querySelector('[data-highlighted]')?.scrollIntoView?.({ block: 'nearest' });
    });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && root?.contains(event.target)) return;
      props.setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    onCleanup(() => document.removeEventListener('pointerdown', outside, true));
  });

  const choose = (option: Option | undefined) => {
    if (option === undefined) return;
    props.setOpen(false);
    props.onPick(option.project);
  };
  /** Moves the highlight by `delta` rows, or to an end. */
  const move = (to: number | 'first' | 'last') => {
    const list = options();
    const from = active() ?? hovered;
    const index = list.findIndex((option) => option.key === from);
    const next =
      to === 'first'
        ? 0
        : to === 'last'
          ? list.length - 1
          : Math.min(list.length - 1, Math.max(0, (index === -1 ? 0 : index) + to));
    setActive(list[next]?.key);
    menu?.querySelector('[data-highlighted]')?.scrollIntoView?.({ block: 'nearest' });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    let handled = true;
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'Home') move('first');
    else if (event.key === 'End') move('last');
    else if (event.key === 'Enter') {
      const key = active() ?? hovered;
      choose(options().find((option) => option.key === key));
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      props.setOpen(false);
      trigger?.focus();
    } else handled = false;
    if (!handled) return;
    // The dialog's own keys, and its close on escape, stay out of the menu.
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div ref={root} class="ss-picker">
      <button
        ref={trigger}
        type="button"
        data-component="button-v2"
        data-size="small"
        data-variant="outline"
        data-expanded={props.open ? '' : undefined}
        class="ss-picker-trigger"
        aria-haspopup="listbox"
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
      <Show when={props.open}>
        <div
          ref={menu}
          data-component="menu-v2-content"
          class="ss-picker-menu"
          role="listbox"
          tabIndex={-1}
          aria-label={ctx.t('browser.picker')}
          aria-activedescendant={active() === undefined ? undefined : optionID(active() ?? '')}
          on:keydown={onKeyDown}
        >
          <Item
            option={{ key: ALL_KEY, project: undefined }}
            active={active() === ALL_KEY}
            checked={props.picked === ALL_KEY}
            onHover={hover}
            onChoose={choose}
          />
          <Show when={props.projects.length > 0}>
            <hr data-slot="menu-v2-separator" />
          </Show>
          <For each={props.projects}>
            {(project) => (
              <Item
                option={{ key: project.key, project }}
                active={active() === project.key}
                checked={props.picked === project.key}
                onHover={hover}
                onChoose={choose}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** The DOM id of a row, for `aria-activedescendant`. */
function optionID(key: string): string {
  return `ss-picker-${key.replace(/[^\w-]/g, '_')}`;
}

/** Props of {@link Item}. */
interface ItemProps {
  readonly option: Option;
  readonly active: boolean;
  readonly checked: boolean;
  readonly onHover: (key: string) => void;
  readonly onChoose: (option: Option) => void;
}

/**
 * A row of the menu as the app's menu items draw: the avatar, the name, the folder and another
 * machine's name muted, what runs or waits at the end, and the check of the picked one.
 */
function Item(props: ItemProps) {
  const ctx = usePlugin();
  const project = () => props.option.project;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the menu takes the keys for its rows.
    <div
      id={optionID(props.option.key)}
      data-component="menu-v2-item"
      class="ss-picker-item"
      role="option"
      tabIndex={-1}
      aria-selected={props.checked}
      data-highlighted={props.active ? '' : undefined}
      data-checked={props.checked ? '' : undefined}
      data-option={props.option.key}
      onPointerMove={() => props.onHover(props.option.key)}
      onClick={() => props.onChoose(props.option)}
    >
      <span data-slot="menu-v2-item-content">
        <span class="ss-picker-icon">
          <Show when={project()} fallback={<ctx.ui.Icon name="workspace" />}>
            {(entry) => <ProjectAvatar look={entry().look} />}
          </Show>
        </span>
        <span class="ss-picker-item-name">
          {project()?.look.name ?? ctx.t('browser.picker.all')}
        </span>
        <Show when={project()}>
          {(entry) => <span class="ss-picker-place">{entry().place}</span>}
        </Show>
        <Show when={project()?.machine}>{(name) => <MachineMark name={name()} />}</Show>
      </span>
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
      <span data-slot="menu-v2-item-indicator" data-checked={props.checked ? '' : undefined}>
        <Show when={props.checked}>
          <ctx.ui.Icon name="check" size="small" />
        </Show>
      </span>
    </div>
  );
}
