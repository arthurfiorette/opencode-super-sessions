import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recognizeLink, trackerLinks } from '../../src/refs/work-link.js';

// Keys are stored through dismissals and dedupe: a wrong key merges two pieces of work into one
// link, or splits one into two that dismissal and dedupe then treat apart. A stored URL must fit
// the metadata schema, or the session's links become unreadable.
test('reads tracker URLs by what they name, and any other web page as a plain link', () => {
  const cases: Array<{ url: string; provider?: string; key?: string; stored?: string }> = [
    {
      url: 'https://linear.app/kepler-crm/issue/COR-1466/evented-engine-retries-a-throwing-loop',
      provider: 'linear',
      key: 'link:linear:kepler-crm/COR-1466'
    },
    {
      url: 'https://dev.azure.com/senior-sistemas/ERP%20-%20Senior/_workitems/edit/140208/',
      provider: 'azure-boards',
      key: 'link:azure-boards:senior-sistemas/140208',
      stored: 'https://dev.azure.com/senior-sistemas/ERP%20-%20Senior/_workitems/edit/140208'
    },
    {
      url: 'https://senior.visualstudio.com/ERP/_boards/board/t/Team/Stories?workitem=140208',
      provider: 'azure-boards',
      key: 'link:azure-boards:senior/140208'
    },
    {
      url: 'https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=ops-12#x',
      provider: 'jira',
      key: 'link:jira:acme.atlassian.net/OPS-12',
      stored: 'https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=ops-12'
    },
    {
      url: 'https://sentry.io/organizations/acme/issues/4567/?project=1',
      provider: 'sentry',
      key: 'link:sentry:acme/4567',
      stored: 'https://sentry.io/organizations/acme/issues/4567?project=1'
    },
    {
      url: 'https://www.notion.so/acme/Launch-plan-0123456789abcdef0123456789ABCDEF',
      provider: 'notion',
      key: 'link:notion:0123456789abcdef0123456789abcdef'
    },
    {
      url: 'https://www.notion.so/acme/Launch-plan-01234567-89ab-cdef-0123-456789abcdef',
      provider: 'notion',
      key: 'link:notion:0123456789abcdef0123456789abcdef'
    },
    {
      url: 'https://acme.slack.com/archives/C024BE91L/p1712345678901234',
      provider: 'slack',
      key: 'link:slack:acme/C024BE91L/p1712345678901234'
    },
    // A reply is part of its thread.
    {
      url: 'https://acme.slack.com/archives/C024BE91L/p1712345699000000?thread_ts=1712345678.901234',
      provider: 'slack',
      key: 'link:slack:acme/C024BE91L/p1712345678901234'
    },
    {
      url: 'https://trello.com/c/AbC123/42-fix-login',
      provider: 'trello',
      key: 'link:trello:AbC123'
    },
    {
      url: 'https://app.shortcut.com/acme/story/77/ship-it',
      provider: 'shortcut',
      key: 'link:shortcut:acme/77'
    },
    {
      url: 'https://app.asana.com/1/111/project/222/task/333',
      provider: 'asana',
      key: 'link:asana:333'
    },
    { url: 'https://app.asana.com/0/222/333/f', provider: 'asana', key: 'link:asana:333' },
    {
      url: 'https://app.clickup.com/t/86b1abcd',
      provider: 'clickup',
      key: 'link:clickup:86b1abcd'
    },
    {
      url: 'https://app.clickup.com/t/9000/ENG-12',
      provider: 'clickup',
      key: 'link:clickup:9000/ENG-12'
    },
    // Pages of a tracker that name no item are plain links.
    {
      url: 'https://linear.app/kepler-crm/project/q4-roadmap',
      provider: 'url',
      key: 'link:url:linear.app/kepler-crm/project/q4-roadmap'
    },
    {
      url: 'https://app.asana.com/0/home/1200',
      provider: 'url',
      key: 'link:url:app.asana.com/0/home/1200'
    },
    {
      url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Runbook',
      provider: 'url',
      key: 'link:url:acme.atlassian.net/wiki/spaces/ENG/pages/1/Runbook'
    },
    // The host and port are case-insensitive and kept; credentials and the fragment are dropped.
    {
      url: 'http://user:secret@LocalHost:3000/Docs/Page?a=1#top',
      provider: 'url',
      key: 'link:url:localhost:3000/Docs/Page?a=1',
      stored: 'http://localhost:3000/Docs/Page?a=1'
    },
    { url: `https://example.com/${'é'.repeat(400)}` },
    { url: 'ftp://example.com/file' },
    { url: 'javascript:alert(1)' },
    { url: 'not a url' }
  ];
  for (const { url, provider, key, stored } of cases) {
    const info = recognizeLink(url);
    if (provider === undefined) {
      assert.equal(info, undefined, url);
      continue;
    }
    assert.deepEqual(
      { provider: info?.provider, key: info?.key, url: info?.url },
      { provider, key, url: stored ?? url },
      url
    );
  }
  // Another URL of the same Linear issue, with another slug, is the same link.
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
    ['link:linear:acme/ENG-1', 'link:jira:acme.atlassian.net/OPS-9']
  );
});
