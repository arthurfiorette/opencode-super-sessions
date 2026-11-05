import { shellCommands } from './detect.js';

// Which branches a shell command pushed, so a branch pull request opened before the session
// still counts for it when the session pushed to that branch. git's own report decides when the
// output holds one; otherwise the command line does, and a push whose target cannot be read
// counts for the branch checked out where it ran, since missing the session's own pull request
// is worse than keeping one it touched.

/** A branch a `git push` names: by name, or the branch checked out where it ran. */
type Target = { name: string } | { current: true };

const CURRENT: Target = { current: true };

// Words that may precede the command itself: assignments, `sudo`, `env`, shell keywords.
const ASSIGNMENT = /^[A-Za-z_]\w*=/u;
const PREFIXES = new Set([
  'if',
  'then',
  'do',
  'else',
  'elif',
  'while',
  'until',
  '!',
  '{',
  'exec',
  'command',
  'builtin',
  'env',
  'nohup',
  'time',
  'sudo'
]);

// git options before the subcommand that take the next word as their value (git.c
// handle_options).
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix'
]);

// `git push` long options that take the next word as their value when not written with `=`
// (builtin/push.c in git 2.47).
const PUSH_VALUE_OPTIONS = new Set([
  '--repo',
  '--push-option',
  '--receive-pack',
  '--exec',
  '--recurse-submodules'
]);

// A redirection word: `2>&1`, `>/dev/null`, `&>log`, or a bare operator whose target follows.
const REDIRECTION = /^(?:\d*|&)[<>]/u;
const BARE_REDIRECTION = /^(?:\d*|&)(?:>>?|<|>&|<&|>\|)$/u;

// One line of git's push report (`print_ref_status` in transport.c): a flag, a summary such as
// `abc1234..def5678` or `[new branch]`, then `src -> dst` with `refs/heads/` dropped. Flags:
// space fast-forward, `+` forced, `*` new, `-` deleted, `!` rejected, `=` up to date.
const STATUS_LINE = /^ ([ +*=!-]) (\[[^\]]*\]|\S+)\s+(\S+) -> (\S+)/u;
const STATUS_OR_DELETED = /^ [ +*=!-] (?:\[[^\]]*\]|\S+)\s+\S/u;
const TO_LINE = /^To \S/u;
const WRITTEN = new Set([' ', '+', '*']);

/** Splits one simple command into words, removing quotes. A word starting with `#` ends it. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? '';
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && '"\\$`'.includes(command[index + 1] ?? ' ')) {
        word += command[++index];
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === '\\') {
      word += command[++index] ?? '';
      inWord = true;
      continue;
    }
    // Subshell parentheses border words, as in `(cd app && git push)`.
    if (/\s/u.test(char) || char === '(' || char === ')') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    if (char === '#' && !inWord) break;
    word += char;
    inWord = true;
  }
  if (inWord) words.push(word);
  return words;
}

/** Index of the command word, past assignments, wrappers and `timeout` with its duration. */
function commandStart(words: string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? '';
    if (ASSIGNMENT.test(word) || PREFIXES.has(word)) {
      index++;
      continue;
    }
    if (word === 'timeout') {
      index++;
      while ((words[index] ?? '').startsWith('-')) index++;
      index++;
      continue;
    }
    break;
  }
  return index;
}

/** The branch a ref name on the remote side stands for, or undefined for tags and other refs. */
function branchOf(ref: string): Target | undefined {
  if (ref === 'HEAD' || ref === '@' || ref.includes('*')) return CURRENT;
  if (ref.startsWith('refs/heads/')) return { name: ref.slice('refs/heads/'.length) };
  if (ref.startsWith('refs/')) return undefined;
  return { name: ref };
}

/**
 * The branch a refspec writes on the remote: `dst` of `src:dst`, else `src`. A leading `+`
 * forces, `^` excludes and `:dst` deletes, so the last two write nothing; `:` alone pushes the
 * matching branches, which include the current one.
 */
function refspecTarget(refspec: string): Target | undefined {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  if (spec.startsWith('^')) return undefined;
  const colon = spec.indexOf(':');
  if (colon === -1) return branchOf(spec);
  const source = spec.slice(0, colon);
  const destination = spec.slice(colon + 1);
  if (source === '' && destination === '') return CURRENT;
  if (source === '') return undefined;
  return branchOf(destination === '' ? source : destination);
}

/**
 * What one `git push` command line writes. Undefined when the words are not a `git push`. An
 * empty list for pushes that write no branch: `--dry-run`, `--delete` and `--tags` alone.
 */
function pushTargets(words: string[]): Target[] | undefined {
  let index = commandStart(words);
  const git = words[index] ?? '';
  if (git !== 'git' && !git.endsWith('/git')) return undefined;
  index++;
  while ((words[index] ?? '').startsWith('-')) {
    index += GIT_VALUE_OPTIONS.has(words[index] ?? '') ? 2 : 1;
  }
  if (words[index] !== 'push') return undefined;

  let repository = false;
  let options = true;
  let all = false;
  let tags = false;
  const refspecs: string[] = [];
  for (index++; index < words.length; index++) {
    const word = words[index] ?? '';
    // A lone `&` sends the command to the background; what follows is another command.
    if (word === '&') break;
    if (REDIRECTION.test(word)) {
      if (BARE_REDIRECTION.test(word)) index++;
      continue;
    }
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && word.startsWith('--')) {
      const name = word.split('=', 1)[0] ?? word;
      if (name === '--dry-run' || name === '--delete') return [];
      if (name === '--all' || name === '--branches' || name === '--mirror') all = true;
      if (name === '--tags') tags = true;
      if (!word.includes('=') && PUSH_VALUE_OPTIONS.has(name)) index++;
      continue;
    }
    if (options && word.startsWith('-') && word.length > 1) {
      // Bundled short flags such as `-fu`; `-o` takes the rest of the word or the next one.
      const flags = word.slice(1);
      if (flags.includes('n') || flags.includes('d')) return [];
      const value = flags.indexOf('o');
      if (value !== -1 && value === flags.length - 1) index++;
      continue;
    }
    if (!repository) repository = true;
    else refspecs.push(word);
  }
  if (all) return [CURRENT];
  if (refspecs.length === 0) return tags ? [] : [CURRENT];
  return refspecs.flatMap((refspec) => {
    const target = refspecTarget(refspec);
    return target === undefined ? [] : [target];
  });
}

/** Every `git push` a shell input runs, as the targets each one names. */
function pushesIn(command: string): Target[][] {
  // Most commands are not pushes; skip the word splitting for them.
  if (!/\bgit\b/u.test(command) || !/\bpush\b/u.test(command)) return [];
  return shellCommands(command).flatMap((segment) => {
    const targets = pushTargets(shellWords(segment));
    return targets === undefined ? [] : [targets];
  });
}

/** Whether a shell input runs `git push`, including pushes that write no branch. */
export function runsPush(command: string): boolean {
  return pushesIn(command).length > 0;
}

/**
 * Whether an output line belongs to git's push report, the part {@link pushedBranches} reads.
 * The history scan keeps these lines of a push command's output and drops the rest.
 */
export function isPushReportLine(line: string): boolean {
  return TO_LINE.test(line) || STATUS_OR_DELETED.test(line);
}

/**
 * The branches git reported writing, or undefined when the output holds no report. A report is
 * a `To <remote>` line followed by status lines; rejected, up-to-date, deleted and tag lines
 * write no branch. `-q`, a report cut off, or a push that failed before connecting leave none.
 */
function reportedBranches(output: string): string[] | undefined {
  const lines = output.split(/\r?\n/u);
  let found = false;
  const branches: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!TO_LINE.test(lines[index] ?? '')) continue;
    for (index++; index < lines.length && STATUS_OR_DELETED.test(lines[index] ?? ''); index++) {
      found = true;
      const status = STATUS_LINE.exec(lines[index] ?? '');
      if (status === null) continue;
      const [, flag = '', summary, , destination = ''] = status;
      if (!WRITTEN.has(flag) || summary === '[new tag]') continue;
      const target = branchOf(destination);
      if (target !== undefined && 'name' in target) branches.push(target.name);
    }
    index--;
  }
  return found ? branches : undefined;
}

/**
 * The branches a shell command pushed. git's report in the output wins; without one, the
 * command line names them, and a push without refspecs, with `HEAD`, `--all` or a pattern counts
 * for `current`, the branch checked out where the session runs. Unread cases, such as
 * `git -C other push`, also count for `current`.
 */
export function pushedBranches(
  command: string,
  output: string,
  current: string | undefined
): string[] {
  const pushes = pushesIn(command);
  if (pushes.length === 0) return [];
  const targets = pushes.flat();
  if (targets.length === 0) return [];
  const names =
    reportedBranches(output) ??
    targets.flatMap((target) =>
      'name' in target ? [target.name] : current === undefined ? [] : [current]
    );
  return [...new Set(names)];
}
