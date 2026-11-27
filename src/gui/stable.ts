import { type Accessor, createComputed, createSignal, untrack } from 'solid-js';

/**
 * A value derived from `read` that cuts the reactive graph where it holds still. A memo would do
 * the same for its value, but Solid marks everything downstream of a changed source as pending
 * before it learns that the memo's value did not change: a route change under the side tab
 * marked every row's computations and checked each of them again. A signal written from a
 * computed stops there, since an equal write marks nothing. Call it under an owner.
 */
export function createStable<T>(
  read: () => T,
  equals: (a: T, b: T) => boolean = Object.is
): Accessor<T> {
  const [value, setValue] = createSignal<T>(untrack(read), { equals });
  createComputed(() => {
    const next = read();
    setValue(() => next);
  });
  return value;
}
