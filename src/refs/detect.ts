import type { ForgeDefinition, RefCandidate, RepoRef } from '../providers/provider.js';
import { type ProviderId, refKey } from './ref.js';

// Shell detection is ported from t3code's PullRequestSyncReactor (commit e1cd7f0).

// Where a shell starts a command, past `NAME=value` assignments and wrappers like `timeout 60`.
// A create command anywhere else, as in `echo gh pr create`, is text, not a command that runs.
const COMMAND_START =
  '(?:^|[;&|({`\\n]|\\b(?:do|then|else)\\s)\\s*(?:(?:\\w+=\\S*|env|time|nohup|timeout\\s+\\S+)\\s+)*';

// Agents run commands as `bash -lc <script>` or `zsh -c <script>`, sometimes quoting the script
// in pieces such as `"a "'`b`'" c"`.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(?=["'])([\s\S]*)$/u;
const SHELL_WORD_PIECE = /"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])|(\S)/gu;

// Heredoc bodies, quoted strings and comments are text a command carries, not commands it runs.
// An unterminated heredoc swallows the rest of the script, as the shell would.
const HEREDOC_BODY =
  /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n(?:(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/gu;
// `#` starts a comment only at the start of a word, so `a#b` and `$#` stay code.
const QUOTED_OR_COMMENT = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"|(?<=^|[\s;&|(])#[^\n]*/gmu;
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/u;

// Only a URL alone on its line is taken: `gh pr create` prints exactly that, while prose that
// quotes a URL usually has words around it.
const URL_LINE = /^[ \t]*(https?:\/\/\S+)[ \t]*$/gmu;

interface Creator {
  definition: ForgeDefinition;
  run: RegExp;
}

/** Compiles each forge's create command so it only matches where a shell command starts. */
function creatorsOf(definitions: ForgeDefinition[]): Creator[] {
  return definitions.map((definition) => ({
    definition,
    // The subcommand must end its shell word: `gh pr create#x` runs another one.
    run: new RegExp(`${COMMAND_START}(?:${definition.createCommand.source})(?=$|[\\s;&|)])`, 'gu')
  }));
}

/** Counts create commands that run in `code`. */
function countCreates(creators: Creator[], code: string): number {
  return creators.reduce((count, { run }) => count + [...code.matchAll(run)].length, 0);
}

/** The script a shell input runs, unwrapped from `sh -c` and its quoting. */
function shellScript(input: string): string {
  const wrapped = SHELL_WRAPPER.exec(input)?.[1];
  if (wrapped === undefined) return input;
  return Array.from(
    wrapped.matchAll(SHELL_WORD_PIECE),
    ([, double, single, escaped, bare]) =>
      double?.replace(/\\(["\\$`])/gu, '$1') ?? single ?? escaped ?? bare
  ).join('');
}

/** Splits a script at command separators that sit outside quotes, keeping the quoted text. */
function shellSegments(script: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let index = 0; index < script.length; index++) {
    const char = script[index] ?? '';
    if (quote !== undefined) {
      current += char;
      // Only double quotes honor backslash escapes; `'a\'` ends at the second quote.
      if (char === '\\' && quote === '"') current += script[++index] ?? '';
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === '\\') {
      current += char + (script[++index] ?? '');
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (pair === '&&' || pair === '||' || char === ';' || char === '|' || char === '\n') {
      segments.push(current);
      current = '';
      if (pair === '&&' || pair === '||') index++;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** The commands a script runs, without heredoc bodies, quoted strings or comments. */
function shellCode(script: string): string {
  return script.replace(HEREDOC_BODY, '<<').replace(QUOTED_OR_COMMENT, "''");
}

/** Identity of a candidate ignoring kind, since GitHub numbers PRs and issues together. */
function numberKey(candidate: RefCandidate): string {
  return `${candidate.provider}:${candidate.host}/${candidate.repo}#${candidate.number}`.toLowerCase();
}

/**
 * Picks one forge per `repo#N` when several read the same text, as `acme/app#12` is valid on
 * GitHub and GitLab alike: `preferred` (the session's forge) when it found it, else the first.
 * The same path and number on two forges in one text is the cost, and it is rare.
 */
function forgeOwners(
  candidates: RefCandidate[],
  preferred: ProviderId | undefined
): Map<string, ProviderId> {
  const owners = new Map<string, ProviderId>();
  for (const candidate of candidates) {
    const key = `${candidate.repo}#${candidate.number}`.toLowerCase();
    const owner = owners.get(key);
    if (owner === undefined || (owner !== preferred && candidate.provider === preferred)) {
      owners.set(key, candidate.provider);
    }
  }
  return owners;
}

/**
 * Drops duplicates, candidates another forge owns (see {@link forgeOwners}), and kind-less
 * candidates when the same number also appeared with a kind.
 */
function dedupe(candidates: RefCandidate[], preferred?: ProviderId): RefCandidate[] {
  const owners = forgeOwners(candidates, preferred);
  const kinded = new Set(candidates.filter((c) => c.kind !== undefined).map(numberKey));
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const owner = owners.get(`${candidate.repo}#${candidate.number}`.toLowerCase());
    if (owner !== candidate.provider) return false;
    const key = numberKey(candidate);
    if (candidate.kind === undefined && kinded.has(key)) return false;
    const full = `${key}/${candidate.kind ?? ''}`;
    if (seen.has(full)) return false;
    seen.add(full);
    return true;
  });
}

/**
 * The refs a shell command created: URLs alone on an output line of a command that runs a
 * forge's create command. A URL whose number the script also names elsewhere (`gh pr view 12`)
 * existed before the command ran. More URLs than create commands means something else printed
 * some, so none are taken.
 */
export function detectCreated(
  definitions: ForgeDefinition[],
  command: string,
  output: string
): RefCandidate[] {
  if (!definitions.some((definition) => definition.createCommand.test(command))) return [];
  const creators = creatorsOf(definitions);
  const script = shellScript(command);
  const code = shellCode(script);
  const creates = countCreates(creators, code);
  if (creates === 0) return [];

  const otherCode = code
    .split(COMMAND_SEPARATOR)
    .filter((part) => countCreates(creators, part) === 0)
    .join('\n');
  if (definitions.some((definition) => definition.listCommand.test(otherCode))) return [];

  // Quoted text in the other commands still counts, as in `printf '.../pull/12'`.
  const otherScript = shellSegments(script)
    .filter((segment) => countCreates(creators, shellCode(segment)) === 0)
    .join('\n');

  // A create command whose text names `issue` creates issues; every other one creates pull
  // requests. This holds for `gh issue create` and `glab issue create` alike.
  const createdKinds = new Set<string>();
  for (const { definition, run } of creators) {
    for (const [match] of code.matchAll(run)) {
      // Re-match without the command-start prefix so `KIND=issue gh pr create` stays a PR.
      const words = definition.createCommand.exec(match)?.[0] ?? match;
      createdKinds.add(`${definition.id}:${/\bissue\b/u.test(words) ? 'issue' : 'pr'}`);
    }
  }

  const created = new Map<string, RefCandidate>();
  for (const [, url = ''] of output.matchAll(URL_LINE)) {
    for (const definition of definitions) {
      const ref = definition.parseUrl(url);
      if (ref === undefined || !createdKinds.has(`${definition.id}:${ref.kind}`)) continue;
      // `!` covers GitLab's merge request spelling, as in `echo !12`.
      const named = new RegExp(`(?:^|(?<=[\\s#!/=("']))${ref.number}(?=$|[\\s);&|/"'])`, 'u');
      if (!named.test(otherScript)) created.set(refKey(ref), ref);
      break;
    }
  }
  return created.size > creates ? [] : [...created.values()];
}

/** Whether a shell command merges or closes a ref, so its cached state should be refreshed. */
export function isCloseCommand(definitions: ForgeDefinition[], command: string): boolean {
  const code = shellCode(shellScript(command));
  return definitions.some((definition) =>
    new RegExp(`${COMMAND_START}(?:${definition.closeCommand.source})`, 'u').test(code)
  );
}

/** URLs and `owner/repo#N` references every forge reads in `text`, before {@link dedupe}. */
function scanAll(definitions: ForgeDefinition[], text: string): RefCandidate[] {
  return definitions.flatMap((definition) => definition.scanText(text));
}

/** URLs and `owner/repo#N` references in assistant text. Never bare `#N`. */
export function detectInText(definitions: ForgeDefinition[], text: string): RefCandidate[] {
  return dedupe(scanAll(definitions, text));
}

/** Refs in a user prompt. */
export interface PromptRefs {
  candidates: RefCandidate[];
  /**
   * The candidates that came from a bare `#N` or `!N`. Only the forge's answer makes one a ref:
   * GitLab's `!` and `#` name a kind, but nothing says the number exists in that project.
   */
  bare: ReadonlySet<RefCandidate>;
}

/**
 * References in a user prompt: everything {@link detectInText} finds plus bare `#N` resolved
 * against `base`. Without a base, bare numbers are ignored because nothing says which repo.
 * A reference several forges read goes to the base's forge.
 */
export function detectInPrompt(
  definitions: ForgeDefinition[],
  text: string,
  base?: RepoRef
): PromptRefs {
  const bare =
    base === undefined
      ? []
      : definitions
          .filter((definition) => definition.id === base.provider)
          .flatMap((definition) => definition.scanBareNumbers(text, base));
  const candidates = dedupe([...scanAll(definitions, text), ...bare], base?.provider);
  const scanned = new Set(bare);
  return { candidates, bare: new Set(candidates.filter((candidate) => scanned.has(candidate))) };
}
