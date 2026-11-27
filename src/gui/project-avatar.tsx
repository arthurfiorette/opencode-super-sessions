import { Show } from 'solid-js';
import type { ProjectIconInfo, ProjectLook } from '../host/gui.js';

// A project's avatar in the app's own markup (PROJECT_AVATAR in src/host/gui.ts), so the app's
// stylesheet draws it as the sidebar does: the user's icon, or the letter on its color.

/** Props of {@link ProjectAvatar}. */
export interface ProjectAvatarProps {
  readonly look: ProjectLook;
  /** Classes of the avatar's frame, for layout. */
  readonly class?: string;
}

/** A 16px project avatar, the sidebar's tile, named by the project for screen readers. */
export function ProjectAvatar(props: ProjectAvatarProps) {
  return (
    <div
      data-component="project-avatar-v2"
      class={props.class}
      role="img"
      aria-label={props.look.name}
    >
      <div
        data-slot="project-avatar-surface"
        data-variant={props.look.variant}
        data-has-image={props.look.src === undefined ? undefined : ''}
      >
        <Show
          when={props.look.src}
          fallback={<span data-slot="project-avatar-initial">{props.look.initial}</span>}
        >
          {(src) => (
            <span data-slot="project-avatar-media">
              <img src={src()} draggable={false} alt="" data-slot="project-avatar-image" />
            </span>
          )}
        </Show>
      </div>
    </div>
  );
}

/** A project as the user set it on this window's routed session, which carries local overrides. */
export interface LocalProject {
  readonly id: string;
  readonly name?: string | undefined;
  readonly icon?: ProjectIconInfo | undefined;
}
