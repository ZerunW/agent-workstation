/**
 * Commands that send data out of a code session (anything that sends data out needs the person's
 * approval, in every permission mode). A conservative matcher over a command line: it splits the line into simple
 * commands (`;`, `&&`, `||`, `|`, `&`, newlines, `$(...)`, backticks, `<(...)`), parses each one's words (quotes and
 * escapes), skips assignments and wrappers (sudo, env, nohup, time, command, exec, nice, timeout, xargs ...), looks
 * inside `bash -c` / `sh -c` / `eval` / `find -exec`, and recognises:
 *   - git push / git send-email (also through `git -c alias.x=...`);
 *   - npm, pnpm, yarn or bun publish; cargo publish; gem push; poetry / uv publish; twine upload (also `python -m twine`);
 *   - gh release upload / gh gist create / gh repo create;
 *   - scp or rsync with a remote destination, sftp, ssh to a host;
 *   - curl with -d / --data* / --json / -F / --form* / -T / --upload-file / -X POST|PUT|PATCH|DELETE; wget with
 *     --post-* / --body-* / --method=POST|PUT|PATCH|DELETE;
 *   - nc / netcat / ncat to a host (not listening), socat with a network address;
 *   - docker / podman / buildah push (also `docker image push`, `--push`).
 * What it cannot see: a script or program that uploads on its own (`npm run deploy`, `python upload.py`, `make`).
 */

/** Command separators and the shell words that only introduce a command. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "in", "case", "esac", "{", "}", "!", "[[", "]]", "function"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "mksh", "busybox"]);

/** Wrappers that run the rest of their arguments as a command: name → options that take a value. */
const WRAPPERS: Record<string, { value: string[]; operands?: number }> = {
  sudo: { value: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir"] },
  doas: { value: ["-u", "-C"] },
  env: { value: ["-u", "-C", "--unset", "--chdir"] },
  nohup: { value: [] },
  time: { value: ["-f", "-o", "--format", "--output"] },
  command: { value: [] },
  builtin: { value: [] },
  exec: { value: ["-a"] },
  nice: { value: ["-n", "--adjustment"] },
  ionice: { value: ["-c", "-n", "-p"] },
  timeout: { value: ["-s", "-k", "--signal", "--kill-after"], operands: 1 },
  stdbuf: { value: ["-i", "-o", "-e"] },
  xargs: { value: ["-I", "-n", "-P", "-d", "-a", "-E", "-L", "-s", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"] },
  watch: { value: ["-n", "-d", "--interval"] },
  unbuffer: { value: [] },
};

/** One parsed piece of a command line. */
type Token = { word: string } | { op: string };

/**
 * Splits a command line into words and operators; the bodies of `$(...)`, backticks and `<(...)` / `>(...)` (also
 * inside double quotes) are returned separately in `nested`, to be checked as command lines of their own.
 */
function tokenize(line: string, nested: string[]): Token[] {
  const out: Token[] = [];
  let word = "";
  let inWord = false;
  let skipNext = false; // the target of a redirection
  const end = (): void => {
    if (inWord) {
      if (skipNext) skipNext = false;
      else out.push({ word });
    }
    word = "";
    inWord = false;
  };
  /** Reads a balanced `( ... )` body starting after the opening paren at `i`; returns the index after `)`. */
  const subshell = (i: number): number => {
    let depth = 1;
    let j = i;
    let quote: string | null = null;
    for (; j < line.length; j++) {
      const c = line[j]!;
      if (quote) {
        if (c === "\\" && quote === '"') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "\\") j++;
      else if (c === "'" || c === '"') quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    nested.push(line.slice(i, j));
    return j + 1;
  };
  const backtick = (i: number): number => {
    let j = i;
    while (j < line.length && line[j] !== "`") j += line[j] === "\\" ? 2 : 1;
    nested.push(line.slice(i, j));
    return j + 1;
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "\\") {
      if (line[i + 1] === "\n") i += 2;
      else {
        word += line[i + 1] ?? "";
        inWord = true;
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      word += j < 0 ? line.slice(i + 1) : line.slice(i + 1, j);
      inWord = true;
      i = j < 0 ? line.length : j + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < line.length && line[i] !== '"') {
        const d = line[i]!;
        if (d === "\\" && i + 1 < line.length) {
          word += line[i + 1];
          i += 2;
        } else if (d === "$" && line[i + 1] === "(") {
          i = subshell(i + 2);
          word += "$()";
        } else if (d === "`") {
          i = backtick(i + 1);
          word += "``";
        } else {
          word += d;
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      i = subshell(i + 2);
      word += "$()";
      inWord = true;
      continue;
    }
    if (c === "`") {
      i = backtick(i + 1);
      word += "``";
      inWord = true;
      continue;
    }
    if ((c === "<" || c === ">") && line[i + 1] === "(") {
      end();
      i = subshell(i + 2);
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && line[i + 1] === ">")) {
      // A redirection: an fd number before it is not a word; its target (the next word) is skipped.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else end();
      i++;
      while (i < line.length && /[<>&|]/.test(line[i]!) && !(line[i] === "&" && line[i + 1] === "&")) i++;
      // `>&2` / `2>&1`: the target is glued to the operator.
      if (/[0-9-]/.test(line[i] ?? "") && /[&]$/.test(line.slice(0, i))) {
        while (i < line.length && /[0-9-]/.test(line[i]!)) i++;
        continue;
      }
      skipNext = true;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      end();
      let op = c;
      if ((c === "&" || c === "|" || c === ";") && line[i + 1] === c) op += c;
      out.push({ op });
      i += op.length;
      continue;
    }
    if (/\s/.test(c)) {
      end();
      i++;
      continue;
    }
    if (c === "#" && !inWord) {
      // A comment, up to the end of the line.
      const nl = line.indexOf("\n", i);
      i = nl < 0 ? line.length : nl;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  end();
  return out;
}

/** The simple commands (word lists) of a command line, nested command lines included. */
function simpleCommands(line: string, depth = 0): string[][] {
  if (depth > 8) return [];
  const nested: string[] = [];
  const tokens = tokenize(line, nested);
  const cmds: string[][] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if ("op" in t) {
      if (cur.length) cmds.push(cur);
      cur = [];
    } else cur.push(t.word);
  }
  if (cur.length) cmds.push(cur);
  for (const n of nested) cmds.push(...simpleCommands(n, depth + 1));
  return cmds;
}

const base = (w: string): string => w.slice(w.lastIndexOf("/") + 1);
const isOption = (w: string): boolean => w.startsWith("-") && w !== "-";
/** The words that are not options (a `--` ends the options). */
function operands(args: string[], valueOpts: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (isOption(a)) {
      if (valueOpts.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `[user@]host:path`, `scp://`, `rsync://` ... (not a local path). */
function isRemoteSpec(w: string): boolean {
  if (/^(rsync|scp|sftp|ssh):\/\//i.test(w)) return true;
  if (/^[/.~]/.test(w)) return false;
  return /^(?:[^\s@/:]+@)?(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9._-]*):/.test(w);
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** curl's short options that take a value (the rest of the word or the next word). */
const CURL_VALUE_SHORT = new Set("AbcCdDeEFhHKmoPQrTtuUwxXyYz".split(""));

function curlSends(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a.startsWith("--")) {
      const [name, value] = a.split("=", 2) as [string, string | undefined];
      if (/^--(data|json|form|upload-file)/.test(name)) return true;
      if (name === "--request") {
        const m = (value ?? args[i + 1] ?? "").toUpperCase();
        if (WRITE_METHODS.has(m)) return true;
      }
      continue;
    }
    if (!a.startsWith("-") || a === "-") continue;
    for (let k = 1; k < a.length; k++) {
      const c = a[k]!;
      if (c === "d" || c === "F" || c === "T") return true;
      if (c === "X") {
        const m = (a.slice(k + 1) || args[i + 1] || "").toUpperCase();
        if (WRITE_METHODS.has(m)) return true;
      }
      if (CURL_VALUE_SHORT.has(c)) {
        if (k === a.length - 1) i++;
        break;
      }
    }
  }
  return false;
}

function wgetSends(args: string[]): boolean {
  return args.some((a) => {
    if (/^--(post|body)-(data|file)/.test(a)) return true;
    const m = /^--method=(.*)$/.exec(a);
    return !!m && WRITE_METHODS.has(m[1]!.toUpperCase());
  }) || args.some((a, i) => a === "--method" && WRITE_METHODS.has((args[i + 1] ?? "").toUpperCase()));
}

/** git's global options that take a value (before the subcommand). */
const GIT_VALUE = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];
const SSH_VALUE = ["-b", "-B", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"];
const SCP_VALUE = ["-c", "-F", "-i", "-J", "-l", "-o", "-P", "-S", "-X"];
const NC_VALUE = ["-s", "-p", "-w", "-i", "-x", "-X", "-O", "-I", "-q", "-e", "-c", "-T", "-V"];

/** The outbound action of one simple command (after wrappers), or null. */
function classify(words: string[], depth: number): string | null {
  let w = [...words];
  // Assignments, shell keywords and wrappers in front of the command.
  for (let guard = 0; guard < 16 && w.length; guard++) {
    const first = w[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || KEYWORDS.has(first)) {
      w = w.slice(1);
      continue;
    }
    const name = base(first);
    const wrap = WRAPPERS[name];
    if (!wrap) break;
    if (name === "env") {
      // env -S / --split-string: the value is a command line of its own.
      const s = w.findIndex((a) => a === "-S" || a === "--split-string" || a.startsWith("--split-string="));
      if (s > 0) {
        const v = w[s]!.includes("=") ? w[s]!.slice(w[s]!.indexOf("=") + 1) : (w[s + 1] ?? "");
        const hit = outboundCommand(v, depth + 1);
        if (hit) return hit;
      }
    }
    let i = 1;
    while (i < w.length && (isOption(w[i]!) || (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]!)))) {
      if (w[i] === "--") {
        i++;
        break;
      }
      if (wrap.value.includes(w[i]!)) i++;
      i++;
    }
    i += wrap.operands ?? 0;
    w = w.slice(i);
  }
  if (!w.length) return null;
  const cmd = base(w[0]!);
  const args = w.slice(1);

  // Shells running a command string, eval, find -exec.
  if (SHELLS.has(cmd)) {
    const sub = cmd === "busybox" ? args : null;
    if (sub && sub.length) return classify(sub, depth);
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--") break;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
        const script = args.slice(i + 1).find((x) => !isOption(x));
        return script ? outboundCommand(script, depth + 1) : null;
      }
      if (a === "-o" || a === "+o" || a === "-O" || a === "+O" || a === "--rcfile" || a === "--init-file") {
        i++;
        continue;
      }
      if (!isOption(a) && !a.startsWith("+")) break;
    }
    return null;
  }
  if (cmd === "eval") return outboundCommand(args.join(" "), depth + 1);
  if (cmd === "find") {
    const at = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir");
    if (at >= 0) {
      const rest = args.slice(at + 1);
      const stop = rest.findIndex((a) => a === ";" || a === "+");
      return classify(stop >= 0 ? rest.slice(0, stop) : rest, depth);
    }
    return null;
  }

  switch (cmd) {
    case "git": {
      // git -c alias.x=push x: an alias may be anything.
      if (args.some((a, i) => args[i - 1] === "-c" && /^alias\./i.test(a))) return "git (with an alias)";
      const sub = operands(args, GIT_VALUE)[0];
      return sub === "push" || sub === "send-email" ? `git ${sub}` : null;
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return operands(args).includes("publish") ? `${cmd} publish` : null;
    case "cargo":
    case "poetry":
    case "uv":
    case "flit":
    case "hatch":
      return operands(args)[0] === "publish" ? `${cmd} publish` : null;
    case "gem":
      return operands(args)[0] === "push" ? "gem push" : null;
    case "twine":
      return operands(args)[0] === "upload" ? "twine upload" : null;
    case "gh": {
      const [a, b] = operands(args, ["-R", "--repo", "--hostname"]);
      if ((a === "release" && b === "upload") || (a === "gist" && b === "create") || (a === "repo" && b === "create")) return `gh ${a} ${b}`;
      return null;
    }
    case "scp":
    case "rsync": {
      const ops = operands(args, cmd === "scp" ? SCP_VALUE : ["-e", "-f", "-T", "-B", "-M", "--rsh"]);
      return ops.slice(1).some(isRemoteSpec) ? `${cmd} to a remote host` : null;
    }
    case "sftp":
      return operands(args, SCP_VALUE).length ? "sftp" : null;
    case "ssh":
    case "mosh":
      return operands(args, SSH_VALUE).length ? `${cmd} to a host` : null;
    case "curl":
      return curlSends(args) ? "curl sending data" : null;
    case "wget":
      return wgetSends(args) ? "wget sending data" : null;
    case "nc":
    case "netcat":
    case "ncat": {
      if (args.some((a) => /^-[A-Za-z]*l/.test(a) || a === "--listen")) return null;
      return operands(args, NC_VALUE).length ? `${cmd} to a host` : null;
    }
    case "socat":
      return args.some((a) => /^(tcp[46]?|udp[46]?|tcp[46]?-connect|udp[46]?-(connect|sendto|datagram)|openssl(-connect)?|ssl|sctp[46]?(-connect)?|socks[45]a?|proxy(-connect)?|dccp[46]?(-connect)?):/i.test(a)) ? "socat to a host" : null;
    case "docker":
    case "podman":
    case "buildah": {
      const ops = operands(args, ["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"]);
      if (ops[0] === "push" || (ops[0] === "image" && ops[1] === "push") || args.includes("--push")) return `${cmd} push`;
      return null;
    }
    default:
      break;
  }
  // python -m twine upload
  if (/^python[0-9.]*$/.test(cmd)) {
    const m = args.indexOf("-m");
    if (m >= 0 && args[m + 1] === "twine" && operands(args.slice(m + 2))[0] === "upload") return "twine upload";
  }
  return null;
}

/**
 * What a command line sends out (a short label such as "git push" or "curl sending data"), or null when nothing in it
 * matches. Conservative: anything unclear about the matched commands counts as outbound.
 */
export function outboundCommand(line: unknown, depth = 0): string | null {
  if (typeof line !== "string" || !line.trim() || depth > 8) return null;
  for (const words of simpleCommands(line, depth)) {
    const hit = classify(words, depth);
    if (hit) return hit;
  }
  return null;
}

export const OUTBOUND_DENIED = "The user did not approve sending data out of this session.";
export const OUTBOUND_NO_ASK = "Sending data out of this session needs the user's approval, which this session does not ask for.";
