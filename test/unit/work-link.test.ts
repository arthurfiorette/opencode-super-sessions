import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recognizeLink, trackerLinks } from '../../src/refs/work-link.js';

// A wrong key merges two pieces of work into one link, or splits one into two that dismissal
// and dedupe then treat apart.
test('recognizes tracker URLs by what they name, and any other web page as a plain link', () => {
  const cases: Array<{ url: string; expected: ReturnType<typeof recognizeLink> | 'same-key-as' }> =
    [
      {
        url: 'https://linear.app/kepler-crm/issue/COR-1466/evented-engine-retries-a-throwing-loop-condition-3-times-instead-of',
        expected: {
          provider: 'linear',
          key: 'link:linear:kepler-crm/cor-1466',
          url: 'https://linear.app/kepler-crm/issue/COR-1466/evented-engine-retries-a-throwing-loop-condition-3-times-instead-of',
          name: 'COR-1466',
          title: 'Evented engine retries a throwing loop condition 3 times instead of'
        }
      },
      {
        url: 'https://dev.azure.com/senior-sistemas/ERP%20-%20Senior/_workitems/edit/140208/',
        expected: {
          provider: 'azure-boards',
          key: 'link:azure-boards:senior-sistemas/140208',
          url: 'https://dev.azure.com/senior-sistemas/ERP%20-%20Senior/_workitems/edit/140208',
          name: '140208',
          title: 'ERP - Senior'
        }
      },
      {
        url: 'https://senior.visualstudio.com/ERP/_boards/board/t/Team/Stories?workitem=140208',
        expected: {
          provider: 'azure-boards',
          key: 'link:azure-boards:senior/140208',
          url: 'https://senior.visualstudio.com/ERP/_boards/board/t/Team/Stories?workitem=140208',
          name: '140208',
          title: 'ERP'
        }
      },
      {
        url: 'https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=ops-12#x',
        expected: {
          provider: 'jira',
          key: 'link:jira:acme.atlassian.net/ops-12',
          url: 'https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=ops-12',
          name: 'OPS-12'
        }
      },
      {
        url: 'https://sentry.io/organizations/acme/issues/4567/?project=1',
        expected: {
          provider: 'sentry',
          key: 'link:sentry:acme/4567',
          url: 'https://sentry.io/organizations/acme/issues/4567?project=1',
          name: '4567'
        }
      },
      {
        url: 'https://www.notion.so/acme/Launch-plan-0123456789abcdef0123456789ABCDEF',
        expected: {
          provider: 'notion',
          key: 'link:notion:0123456789abcdef0123456789abcdef',
          url: 'https://www.notion.so/acme/Launch-plan-0123456789abcdef0123456789ABCDEF',
          title: 'Launch plan'
        }
      },
      {
        url: 'https://acme.slack.com/archives/C024BE91L/p1712345678901234',
        expected: {
          provider: 'slack',
          key: 'link:slack:acme/c024be91l/p1712345678901234',
          url: 'https://acme.slack.com/archives/C024BE91L/p1712345678901234',
          title: 'Slack thread'
        }
      },
      {
        url: 'https://trello.com/c/AbC123/42-fix-login',
        expected: {
          provider: 'trello',
          key: 'link:trello:abc123',
          url: 'https://trello.com/c/AbC123/42-fix-login',
          title: 'Fix login'
        }
      },
      {
        url: 'https://app.shortcut.com/acme/story/77/ship-it',
        expected: {
          provider: 'shortcut',
          key: 'link:shortcut:acme/77',
          url: 'https://app.shortcut.com/acme/story/77/ship-it',
          name: 'sc-77',
          title: 'Ship it'
        }
      },
      {
        url: 'https://app.asana.com/1/111/project/222/task/333',
        expected: {
          provider: 'asana',
          key: 'link:asana:333',
          url: 'https://app.asana.com/1/111/project/222/task/333',
          title: 'Asana task'
        }
      },
      {
        url: 'https://app.clickup.com/t/86b1abcd',
        expected: {
          provider: 'clickup',
          key: 'link:clickup:86b1abcd',
          url: 'https://app.clickup.com/t/86b1abcd',
          name: '86b1abcd'
        }
      },
      // A Linear page that is not an issue, and a Confluence page on a Jira site, are plain links.
      {
        url: 'https://linear.app/kepler-crm/project/q4-roadmap',
        expected: {
          provider: 'url',
          key: 'link:url:linear.app/kepler-crm/project/q4-roadmap',
          url: 'https://linear.app/kepler-crm/project/q4-roadmap',
          name: 'linear.app',
          title: '/kepler-crm/project/q4-roadmap'
        }
      },
      {
        url: 'https://WWW.Example.com/Docs/Page?a=1#top',
        expected: {
          provider: 'url',
          key: 'link:url:www.example.com/Docs/Page?a=1',
          url: 'https://www.example.com/Docs/Page?a=1',
          name: 'example.com',
          title: '/Docs/Page?a=1'
        }
      },
      { url: 'ftp://example.com/file', expected: undefined },
      { url: 'javascript:alert(1)', expected: undefined },
      { url: 'not a url', expected: undefined }
    ];
  for (const { url, expected } of cases) {
    assert.deepEqual(recognizeLink(url), expected, url);
  }
  // Another URL of the same Linear issue, with a different slug, is the same link.
  assert.equal(
    recognizeLink('https://linear.app/kepler-crm/issue/cor-1466')?.key,
    recognizeLink('https://linear.app/kepler-crm/issue/COR-1466/other-slug')?.key
  );
});

// Prompts link only tracker pages; documentation and search results pasted in a prompt are not
// work the session tracks.
test('a prompt links tracker URLs once each and leaves other pages alone', () => {
  const prompt =
    'Fix https://linear.app/acme/issue/ENG-1/crash. See https://docs.example.com/guide and ' +
    '[the ticket](https://linear.app/acme/issue/ENG-1) or (https://acme.atlassian.net/browse/OPS-9).';
  assert.deepEqual(
    trackerLinks(prompt).map((link) => link.key),
    ['link:linear:acme/eng-1', 'link:jira:acme.atlassian.net/ops-9']
  );
});
