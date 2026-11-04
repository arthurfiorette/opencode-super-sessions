import { jsx } from '@opentui/solid/jsx-runtime';
import type { PageProps } from './page.js';

/** Session page. Replaced by the full browser in a later step. */
export default function SessionPage(props: PageProps) {
  return jsx('box', {
    width: '100%',
    height: '100%',
    get backgroundColor() {
      return props.context.theme.background.base;
    },
    children: jsx('text', {
      get fg() {
        return props.context.theme.text.base;
      },
      children: 'Sessions'
    })
  });
}
