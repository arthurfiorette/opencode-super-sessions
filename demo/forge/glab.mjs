// The demo's `glab`, run through the shim start.mjs writes (see gh.mjs). Answers `auth status`
// and the three GraphQL documents the GitLab provider builds: aliased snapshots, merge request
// details and source branch lookups. The test suite has no fake glab, so this protocol lives
// here only.

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { gitlabData } from './data.mjs';

const args = process.argv.slice(2);
const data = gitlabData(Number(process.env.DEMO_SEEDED_AT));
appendFileSync(
  path.join(process.env.DEMO_STATE, 'forge.log'),
  `${new Date().toISOString()} glab ${args.join(' ')}\n`
);

/** Prints a `glab api --include` style response and exits 0, as glab does without errors. */
function reply(body) {
  process.stdout.write(
    `HTTP/2.0 200 OK\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`
  );
  process.exit(0);
}

/**
 * Answers one snapshot document from its aliases. GitLab returns a missing project, merge
 * request or issue as a plain null without an error.
 */
function snapshot(query, variables) {
  const answer = { metadata: { enterprise: false } };
  const projects = [...query.matchAll(/(p\d+): project\(fullPath: \$p\d+\)/g)];
  for (const [position, match] of projects.entries()) {
    const [, alias] = match;
    const body = query.slice(match.index, projects[position + 1]?.index);
    const project = String(variables[alias]).toLowerCase();
    answer[alias] = {};
    for (const [, item, kind, number] of body.matchAll(
      /(\w\d+): (mergeRequest|issue)\(iid: "(\d+)"\)/g
    )) {
      const table = kind === 'issue' ? data.issues : data.mergeRequests;
      answer[alias][item] = table[`${project}${kind === 'issue' ? '#' : '!'}${number}`] ?? null;
    }
  }
  reply({ data: answer });
}

/** Answers the details lookup of one merge request. */
function details(variables) {
  const found = data.details[`${variables.path}!${variables.iid}`.toLowerCase()];
  if (!found) {
    reply({ data: { project: { mergeRequest: null } } });
    return;
  }
  const { jobs, ...rest } = found;
  reply({
    data: {
      project: {
        mergeRequest: {
          ...rest,
          headPipeline: { jobs: { pageInfo: { hasNextPage: false }, nodes: jobs } }
        }
      }
    }
  });
}

/** Answers a source branch lookup. */
function branch(variables) {
  const project = String(variables.path).toLowerCase();
  const nodes = (data.branches[`${project}@${variables.branch}`] ?? []).map((number) => ({
    iid: String(number),
    state: data.mergeRequests[`${project}!${number}`].state,
    sourceProject: { fullPath: project }
  }));
  reply({ data: { project: { mergeRequests: { nodes } } } });
}

if (args[0] === 'auth' && args[1] === 'status') {
  console.log('gitlab.com\n  ✓ Logged in to gitlab.com as ben-acme');
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    const { query, variables } = JSON.parse(input);
    if (query.includes('mergeRequests(sourceBranches')) branch(variables);
    else if (query.includes('mergeRequest(iid: $iid)')) details(variables);
    else snapshot(query, variables);
  });
} else {
  console.error(`fake glab: unsupported command ${args.join(' ')}`);
  process.exit(2);
}
