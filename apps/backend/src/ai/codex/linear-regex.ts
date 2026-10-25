// A LINEAR-TIME pattern matcher for the workspace MCP server's `search` and `list_files` globs.
//
// WHY NOT `new RegExp(pattern)`. The pattern is written by the model, and the model reads a pull
// request — attacker-authored text. JavaScript's RegExp backtracks: `(a+)+$` against a line of forty
// `a`s and a `b` pins the event loop for minutes. CLAUDE.md's rule for the reference-docs crawler
// applies here too: no backtracking RegExp over untrusted input.
//
// HOW. The pattern is parsed into a small AST and compiled to a Thompson NFA, which is run as a Pike
// VM without captures: every position of the line advances EVERY live state at once, so the cost of
// one line is O(line length × program size), whatever the pattern is. The program size is capped
// (MAX_PROGRAM), and every call draws on a caller-held WORK BUDGET, so one search over a huge file
// stops with a stated reason rather than running on.
//
// SUPPORTED: literals, `.`, classes `[a-z]` / `[^…]`, `\d \w \s \D \W \S`, `\b \B`, `^ $` (per
// line), groups `( )` `(?: )` `(?<name> )`, alternation `|`, quantifiers `* + ? {n} {n,} {n,m}`
// (a trailing lazy `?` is accepted and changes nothing — the question is only "does this line
// match"), escapes `\t \n \r \f \v \0 \xHH \uHHHH \u{H…}` and any escaped punctuation.
// REFUSED with a sentence: back-references and look-around — neither can run in linear time.

/** A work allowance shared by every `test` of one tool call. */
export interface WorkBudget {
  left: number;
  exhausted: boolean;
}

export function workBudget(steps: number): WorkBudget {
  return { left: steps, exhausted: false };
}

export interface LinearMatcher {
  /** Does the pattern match anywhere in `text` (or, for an anchored pattern, all of it)? */
  test(text: string, budget: WorkBudget): boolean;
}

/** A pattern the matcher cannot compile; `message` is a sentence the model can act on. */
export class PatternError extends Error {}

const MAX_PATTERN_CHARS = 1000;
const MAX_PROGRAM = 5000;
const MAX_REPEAT = 1000;

type Pred = (c: number) => boolean;
type AssertKind = 'bol' | 'eol' | 'wordb' | 'nwordb';
type Node =
  | { t: 'char'; pred: Pred }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number }
  | { t: 'assert'; kind: AssertKind };

type Inst =
  | { op: 'char'; pred: Pred }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'assert'; kind: AssertKind }
  | { op: 'match' };

const isDigit: Pred = (c) => c >= 48 && c <= 57;
const isWordChar: Pred = (c) => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const SPACE_RE = /\s/; // one character at a time: no backtracking possible
const isSpace: Pred = (c) => SPACE_RE.test(String.fromCharCode(c));
const not = (p: Pred): Pred => (c) => !p(c);
const isLineBreak = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

function caseFold(p: Pred): Pred {
  return (c) => {
    if (p(c)) return true;
    const s = String.fromCharCode(c);
    const lo = s.toLowerCase();
    const up = s.toUpperCase();
    return (lo.length === 1 && p(lo.charCodeAt(0))) || (up.length === 1 && p(up.charCodeAt(0)));
  };
}

class Parser {
  private i = 0;
  constructor(
    private readonly src: string,
    private readonly ignoreCase: boolean,
  ) {}

  parse(): Node {
    const node = this.alt();
    if (this.i < this.src.length) throw new PatternError(`Unmatched ")" at position ${this.i + 1} of the pattern.`);
    return node;
  }

  private peek(): string | undefined {
    return this.src[this.i];
  }

  private lit(pred: Pred): Node {
    return { t: 'char', pred: this.ignoreCase ? caseFold(pred) : pred };
  }

  private alt(): Node {
    const items = [this.concat()];
    while (this.peek() === '|') {
      this.i++;
      items.push(this.concat());
    }
    return items.length === 1 ? items[0]! : { t: 'alt', items };
  }

  private concat(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.peek() !== '|' && this.peek() !== ')') items.push(this.repeat());
    return items.length === 1 ? items[0]! : { t: 'cat', items };
  }

  private repeat(): Node {
    const c = this.peek();
    if (c === '*' || c === '+' || c === '?') throw new PatternError(`Nothing to repeat before "${c}" at position ${this.i + 1}.`);
    let node = this.atom();
    for (;;) {
      const q = this.peek();
      let min: number;
      let max: number;
      if (q === '*') [min, max] = [0, Infinity];
      else if (q === '+') [min, max] = [1, Infinity];
      else if (q === '?') [min, max] = [0, 1];
      else if (q === '{') {
        const bounds = this.braces();
        if (!bounds) return node; // not a quantifier: the next atom reads the "{" as a literal
        [min, max] = bounds;
      } else return node;
      if (q !== '{') this.i++;
      if (this.peek() === '?') this.i++; // lazy: same answer for "does it match"
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
        throw new PatternError(`A repeat count above ${MAX_REPEAT} is not supported.`);
      }
      if (max < min) throw new PatternError('A repeat range must not run backwards ({n,m} needs n ≤ m).');
      node = { t: 'rep', node, min, max };
    }
  }

  /** Parse `{n}`, `{n,}` or `{n,m}` at the cursor; null (cursor unmoved) when it is a literal "{". */
  private braces(): [number, number] | null {
    const start = this.i;
    let j = start + 1;
    const digits = (): string => {
      let s = '';
      while (j < this.src.length && isDigit(this.src.charCodeAt(j)) && s.length < 7) s += this.src[j++];
      return s;
    };
    const a = digits();
    if (a === '') return null;
    let max: number;
    if (this.src[j] === ',') {
      j++;
      const b = digits();
      max = b === '' ? Infinity : Number(b);
    } else max = Number(a);
    if (this.src[j] !== '}') return null;
    this.i = j + 1;
    return [Number(a), max];
  }

  private atom(): Node {
    const c = this.src[this.i++]!;
    switch (c) {
      case '(': {
        if (this.peek() === '?') {
          const next = this.src[this.i + 1];
          const after = this.src[this.i + 2];
          if (next === ':') this.i += 2;
          else if (next === '<' && after !== '=' && after !== '!') {
            const close = this.src.indexOf('>', this.i);
            if (close === -1) throw new PatternError('A named group "(?<name>" is missing its ">".');
            this.i = close + 1;
          } else {
            throw new PatternError('Look-around ("(?=", "(?!", "(?<=", "(?<!") is not supported. Search for the text itself.');
          }
        }
        const inner = this.alt();
        if (this.peek() !== ')') throw new PatternError('A group "(" is missing its ")".');
        this.i++;
        return inner;
      }
      case '[':
        return this.charClass();
      case '.':
        return { t: 'char', pred: (x) => !isLineBreak(x) };
      case '^':
        return { t: 'assert', kind: 'bol' };
      case '$':
        return { t: 'assert', kind: 'eol' };
      case '\\':
        return this.escape(false) as Node;
      default:
        return this.lit(((code) => (x: number) => x === code)(c.charCodeAt(0)));
    }
  }

  /** After a backslash. In a class (`inClass`), `\b` is a backspace and assertions are not allowed. */
  private escape(inClass: boolean): Node | Pred {
    const c = this.src[this.i++];
    if (c === undefined) throw new PatternError('The pattern ends with a lone "\\".');
    const charOf = (code: number): Node | Pred => {
      if (inClass) {
        this.lastCode = code;
        return (x) => x === code;
      }
      return this.lit((x) => x === code);
    };
    const cls = (p: Pred): Node | Pred => (inClass ? p : { t: 'char', pred: p });
    switch (c) {
      case 'd':
        return cls(isDigit);
      case 'D':
        return cls(not(isDigit));
      case 'w':
        return cls(isWordChar);
      case 'W':
        return cls(not(isWordChar));
      case 's':
        return cls(isSpace);
      case 'S':
        return cls(not(isSpace));
      case 'b':
        return inClass ? charOf(8) : { t: 'assert', kind: 'wordb' };
      case 'B':
        if (inClass) throw new PatternError('"\\B" cannot be used inside [ ].');
        return { t: 'assert', kind: 'nwordb' };
      case 't':
        return charOf(9);
      case 'n':
        return charOf(10);
      case 'r':
        return charOf(13);
      case 'f':
        return charOf(12);
      case 'v':
        return charOf(11);
      case '0':
        return charOf(0);
      case 'x': {
        const hex = this.src.slice(this.i, this.i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return charOf('x'.charCodeAt(0));
        this.i += 2;
        return charOf(parseInt(hex, 16));
      }
      case 'u': {
        if (this.peek() === '{') {
          const close = this.src.indexOf('}', this.i);
          const hex = close === -1 ? '' : this.src.slice(this.i + 1, close);
          if (/^[0-9a-fA-F]{1,4}$/.test(hex)) {
            this.i = close + 1;
            return charOf(parseInt(hex, 16));
          }
          throw new PatternError('Only "\\u{…}" escapes up to FFFF are supported.');
        }
        const hex = this.src.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return charOf('u'.charCodeAt(0));
        this.i += 4;
        return charOf(parseInt(hex, 16));
      }
      default:
        if (c >= '1' && c <= '9') throw new PatternError('Back-references ("\\1") are not supported.');
        if (c === 'k' && this.peek() === '<') throw new PatternError('Back-references ("\\k<name>") are not supported.');
        return charOf(c.charCodeAt(0));
    }
  }

  private charClass(): Node {
    let negate = false;
    if (this.peek() === '^') {
      negate = true;
      this.i++;
    }
    const preds: Pred[] = [];
    let first = true;
    for (;;) {
      if (this.i >= this.src.length) throw new PatternError('A "[" is missing its "]".');
      const c = this.src[this.i]!;
      if (c === ']' && !first) {
        this.i++;
        break;
      }
      first = false;
      const lo = this.classAtom();
      if (this.peek() === '-' && this.src[this.i + 1] !== undefined && this.src[this.i + 1] !== ']') {
        this.i++;
        const hi = this.classAtom();
        if (typeof lo === 'number' && typeof hi === 'number') {
          if (hi < lo) throw new PatternError('A range in [ ] must not run backwards (like [z-a]).');
          preds.push((x) => x >= lo && x <= hi);
          continue;
        }
        // `[\d-z]`: not a range — the parts and a literal "-".
        preds.push(typeof lo === 'number' ? (x) => x === lo : lo, (x) => x === 45, typeof hi === 'number' ? (x) => x === hi : hi);
        continue;
      }
      preds.push(typeof lo === 'number' ? (x) => x === lo : lo);
    }
    const any: Pred = (x) => {
      for (const p of preds) if (p(x)) return true;
      return false;
    };
    const base = this.ignoreCase ? caseFold(any) : any;
    return { t: 'char', pred: negate ? not(base) : base };
  }

  /** One member of a class: a code unit, or a class escape's predicate. */
  private classAtom(): number | Pred {
    const c = this.src[this.i++]!;
    if (c !== '\\') return c.charCodeAt(0);
    // A one-character escape records its code unit (so it can bound a range); a class escape
    // (`\d`, `\w`, …) leaves `lastCode` null and stays a predicate.
    this.lastCode = null;
    const e = this.escape(true) as Pred;
    return this.lastCode ?? e;
  }

  private lastCode: number | null = null;
}

function compile(node: Node, anchored: boolean): Inst[] {
  const prog: Inst[] = [];
  const emit = (inst: Inst): number => {
    if (prog.length >= MAX_PROGRAM) throw new PatternError('The pattern is too complex. Use a shorter pattern or fewer repeats.');
    prog.push(inst);
    return prog.length - 1;
  };
  const gen = (n: Node): void => {
    switch (n.t) {
      case 'char':
        emit({ op: 'char', pred: n.pred });
        return;
      case 'assert':
        emit({ op: 'assert', kind: n.kind });
        return;
      case 'cat':
        for (const item of n.items) gen(item);
        return;
      case 'alt': {
        const jumps: number[] = [];
        n.items.forEach((item, k) => {
          if (k < n.items.length - 1) {
            const split = emit({ op: 'split', x: 0, y: 0 });
            (prog[split] as { x: number }).x = prog.length;
            gen(item);
            jumps.push(emit({ op: 'jmp', x: 0 }));
            (prog[split] as { y: number }).y = prog.length;
          } else gen(item);
        });
        for (const j of jumps) (prog[j] as { x: number }).x = prog.length;
        return;
      }
      case 'rep': {
        for (let k = 0; k < n.min; k++) gen(n.node);
        if (n.max === Infinity) {
          const split = emit({ op: 'split', x: 0, y: 0 });
          (prog[split] as { x: number }).x = prog.length;
          gen(n.node);
          emit({ op: 'jmp', x: split });
          (prog[split] as { y: number }).y = prog.length;
        } else {
          const splits: number[] = [];
          for (let k = n.min; k < n.max; k++) {
            const split = emit({ op: 'split', x: 0, y: 0 });
            (prog[split] as { x: number }).x = prog.length;
            splits.push(split);
            gen(n.node);
          }
          for (const s of splits) (prog[s] as { y: number }).y = prog.length;
        }
        return;
      }
    }
  };
  if (anchored) emit({ op: 'assert', kind: 'bol' });
  gen(node);
  if (anchored) emit({ op: 'assert', kind: 'eol' });
  emit({ op: 'match' });
  return prog;
}

function matcherFor(prog: Inst[], anchored: boolean): LinearMatcher {
  const n = prog.length;
  const mark = new Int32Array(n);
  let gen = 0;
  let clist = new Int32Array(n);
  let nlist = new Int32Array(n);
  const stack = new Int32Array(n * 2 + 2);
  return {
    test(text, budget) {
      if (budget.exhausted) return false;
      const len = text.length;
      const assertHolds = (kind: AssertKind, pos: number): boolean => {
        if (kind === 'bol') return pos === 0;
        if (kind === 'eol') return pos === len;
        const before = pos > 0 && isWordChar(text.charCodeAt(pos - 1));
        const after = pos < len && isWordChar(text.charCodeAt(pos));
        return kind === 'wordb' ? before !== after : before === after;
      };
      // Add the epsilon-closure of `pc` at `pos` to `list`; true when it reaches `match`.
      const add = (list: Int32Array, count: { n: number }, pc0: number, pos: number): boolean => {
        let sp = 0;
        stack[sp++] = pc0;
        while (sp > 0) {
          const pc = stack[--sp]!;
          if (mark[pc] === gen) continue;
          mark[pc] = gen;
          if (--budget.left < 0) {
            budget.exhausted = true;
            return false;
          }
          const inst = prog[pc]!;
          switch (inst.op) {
            case 'match':
              return true;
            case 'jmp':
              stack[sp++] = inst.x;
              break;
            case 'split':
              stack[sp++] = inst.y;
              stack[sp++] = inst.x;
              break;
            case 'assert':
              if (assertHolds(inst.kind, pos)) stack[sp++] = pc + 1;
              break;
            case 'char':
              list[count.n++] = pc;
              break;
          }
        }
        return false;
      };
      gen++;
      const cc = { n: 0 };
      if (add(clist, cc, 0, 0)) return true;
      for (let pos = 0; pos < len; pos++) {
        if (budget.exhausted) return false;
        const c = text.charCodeAt(pos);
        gen++;
        const nc = { n: 0 };
        for (let k = 0; k < cc.n; k++) {
          const pc = clist[k]!;
          if (--budget.left < 0) {
            budget.exhausted = true;
            return false;
          }
          if ((prog[pc] as { pred: Pred }).pred(c) && add(nlist, nc, pc + 1, pos + 1)) return true;
        }
        // Unanchored search: a match may also start at the next position.
        if (!anchored && add(nlist, nc, 0, pos + 1)) return true;
        if (budget.exhausted) return false;
        [clist, nlist] = [nlist, clist];
        cc.n = nc.n;
        if (anchored && cc.n === 0) return false;
      }
      return false;
    },
  };
}

/** Compile a regular expression (the subset above) into a linear-time matcher. */
export function compileLinearRegex(pattern: string, opts: { ignoreCase?: boolean } = {}): LinearMatcher {
  if (pattern.length > MAX_PATTERN_CHARS) throw new PatternError(`The pattern is longer than ${MAX_PATTERN_CHARS} characters.`);
  const ast = new Parser(pattern, opts.ignoreCase === true).parse();
  return matcherFor(compile(ast, false), false);
}

const REGEX_META = /[\\^$.*+?()[\]{}|/]/;

/**
 * Compile a file glob into an ANCHORED linear matcher over a `/`-separated relative path.
 * `*` and `?` never cross `/`; `**` crosses it, and `**\/` also matches no directory at all;
 * `[abc]`, `[!abc]` and `{a,b}` (nestable) are supported.
 */
export function compileGlob(glob: string): LinearMatcher {
  if (glob.length > MAX_PATTERN_CHARS) throw new PatternError(`The glob is longer than ${MAX_PATTERN_CHARS} characters.`);
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        const atStart = i === 0 || glob[i - 1] === '/';
        if (atStart && slash) {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close === -1) re += '\\[';
      else {
        let body = glob.slice(i + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth > 0) {
      depth--;
      re += ')';
    } else if (c === ',' && depth > 0) re += '|';
    else if (c === '\\' && i + 1 < glob.length) {
      const next = glob[++i]!;
      re += REGEX_META.test(next) ? `\\${next}` : next;
    } else re += REGEX_META.test(c) ? `\\${c}` : c;
  }
  if (depth > 0) throw new PatternError('A "{" in the glob is missing its "}".');
  const ast = new Parser(re, false).parse();
  return matcherFor(compile(ast, true), true);
}
