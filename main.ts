// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

const MOVES: {old:string;new:string}[] = [];
let STRICT = false;
const TIERS = (): number[] => STRICT ? [0] : [0, 1, 2];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  MOVES.length = 0;
  STRICT = strict;
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = formatEdits(kind, text, lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const moveByNew = new Map(MOVES.map((m) => [m.new, m.old]));
  const moveOlds = new Set(MOVES.map((m) => m.old));
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const mvOld = moveByNew.get(p);
    if (now !== null && was === null && mvOld !== undefined) rows.push(`R ${mvOld} -> ${p}`);
    else if (!(now === null && moveOlds.has(p))) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

function findOccurrence(fileLines:string[], oldLines:string[], strict:boolean): {pos:number,tier:number}|null {
  const tiers = strict ? [0] : [0,1,2];
  const norm=(s:string,t:number)=>t===0?s:t===1?s.replace(/[ \t]+$/,' '):s.trim();
  for (const t of tiers) {
    for (let i=0;i+oldLines.length<=fileLines.length;i++) {
      let ok=true;
      for (let j=0;j<oldLines.length;j++) {
        const a=norm(fileLines[i+j]!,t), b=norm(oldLines[j]!,t);
        if (t===1) { if (a.replace(/[ \t]+$/,'')!==b.replace(/[ \t]+$/,'')) {ok=false;break;} }
        else if (a!==b) {ok=false;break;}
      }
      if(ok) return {pos:i,tier:t};
    }
  }
  return null;
}

function reindent(fileLines:string[], pos:number, newLines:string[], tier:number, oldFirstIndent:string): string[] {
  if (tier !== 2) return newLines;
  const m = /^[ \t]*/.exec(fileLines[pos] ?? '');
  const F = m ? m[0] : '';
  return newLines.map((line) => {
    if (oldFirstIndent !== '' && line.startsWith(oldFirstIndent)) {
      return F + line.slice(oldFirstIndent.length);
    }
    return line;
  });
}

interface Shape { lines: string[]; eol: string; finalBreak: boolean }

function shape(text: string): Shape {
  const nl = text.indexOf('\n');
  const eol = nl >= 0 && nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(eol);
  const finalBreak = text !== '' && text.endsWith(eol);
  if (finalBreak && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol, finalBreak };
}

function unshape(s: Shape): string {
  return s.lines.length === 0 ? '' : s.lines.join(s.eol) + (s.finalBreak ? s.eol : '');
}

function getShape(t: Tree, p: string): Shape | null {
  const text = t.get(p);
  return text === null ? null : shape(text);
}

function putShape(t: Tree, p: string, s: Shape): void {
  t.now.set(p, unshape(s));
}

function lead(s: string): string {
  return (s.match(/^[ \t]*/) ?? [''])[0];
}

function buildOccurrence(body: {kind:string,text:string}[], fileLines: string[], pos: number, tier: number, oldFirstIndent?: string): string[] {
  const F = lead(fileLines[pos] || '');
  const firstO = body.find((e) => e.kind === ' ' || e.kind === '-');
  const P = oldFirstIndent !== undefined ? oldFirstIndent : (firstO ? lead(firstO.text) : '');
  const out: string[] = [];
  let oi = pos;
  for (const e of body) {
    if (e.kind === '-') {
      oi++;
    } else if (e.kind === ' ') {
      out.push(fileLines[oi++] ?? '');
    } else if (e.kind === '+') {
      const text = e.text;
      if (tier === 2 && text.trim() !== '' && text.startsWith(P)) {
        out.push(F + text.slice(P.length));
      } else {
        out.push(text);
      }
    }
  }
  return out;
}

interface Hunk { a:number; body:{kind:string,text:string}[]; noNewline:boolean }
interface Section { kind:string; oldPath:string; newPath:string; hunks:Hunk[]; fc?:boolean; fd?:boolean; fromGit?:boolean }

function parseHeaderPath(raw: string): string {
  let s = raw.split('\t')[0]!.trim();
  if (s === '/dev/null') return '';
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const isGit = (s: string) => s.startsWith('diff --git ');
  const isPair = (n: number) => lines[n] !== undefined && lines[n]!.startsWith('--- ') &&
    lines[n + 1] !== undefined && lines[n + 1]!.startsWith('+++ ');

  while (i < lines.length) {
    const line = lines[i]!;
    if (isGit(line)) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { kind: 'change', oldPath: m[1]!, newPath: m[2]!, hunks: [], fromGit: true };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && isPair(i)) {
      const oldPath = parseHeaderPath(line.slice(4));
      const newPath = parseHeaderPath(lines[i + 1]!.slice(4));
      if (cur && cur.fromGit && cur.hunks.length === 0) {
        cur.oldPath = oldPath;
        cur.newPath = newPath;
      } else {
        cur = { kind: 'change', oldPath, newPath, hunks: [] };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur && cur.hunks.length === 0 && !line.startsWith('@@')) {
      if (line.startsWith('new file mode')) { (cur as any).fc = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { (cur as any).fd = true; i++; continue; }
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) { i++; continue; }
      const rp = /^rename from (.+)$/.exec(line);
      if (rp) { cur.oldPath = parseHeaderPath(rp[1]!); i++; continue; }
      const rt = /^rename to (.+)$/.exec(line);
      if (rt) { cur.newPath = parseHeaderPath(rt[1]!); i++; continue; }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [], noNewline: false };
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && isPair(i)) || b.startsWith('@@')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (b === '') hunk.body.push({ kind: ' ', text: '' });
          else if (b.startsWith('\\')) { hunk.noNewline = true; }
          else hunk.body.push({ kind: b[0]!, text: b.slice(1) });
          i++;
          continue;
        }
        if (b.startsWith('\\')) { hunk.noNewline = true; i++; continue; }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === ' ' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    i++;
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');
  for (const s of sections) {
    if (s.fc || s.oldPath === '') s.kind = 'create';
    else if (s.fd || s.newPath === '') s.kind = 'delete';
    else if (s.oldPath !== s.newPath) s.kind = 'move';
    else s.kind = 'change';
  }
  return sections;
}

function uNorm(s: string, tier: number): string { return tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, ' ') : s.trim(); }
function uEq(a: string, b: string, tier: number): boolean {
  return tier === 1
    ? uNorm(a, 1).replace(/[ \t]+$/, '') === uNorm(b, 1).replace(/[ \t]+$/, '')
    : uNorm(a, tier) === uNorm(b, tier);
}
function uPositions(fl: string[], O: {text:string}[], tier: number): number[] {
  const res: number[] = [];
  for (let i = 0; i + O.length <= fl.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) { if (!uEq(fl[i + j]!, O[j]!.text, tier)) { ok = false; break; } }
    if (ok) res.push(i);
  }
  return res;
}
function uApplyHunks(sh: Shape, hunks: Hunk[], path: string): Shape {
  let d = 0;
  for (const h of hunks) {
    const O = h.body.filter((e) => e.kind === ' ' || e.kind === '-');
    const A = h.a;
    let pos = -1, tier = 0;
    if (O.length > 0) {
      for (const tt of TIERS()) {
        const ps = uPositions(sh.lines, O, tt);
        if (ps.length) {
          tier = tt; pos = ps[0]!;
          let bd = Math.abs(pos - (A - 1 + d));
          for (const p of ps) { const dd = Math.abs(p - (A - 1 + d)); if (dd < bd) { bd = dd; pos = p; } }
          break;
        }
      }
      if (pos < 0) throw new Fail('no-match', path);
    } else { pos = Math.min(A + d, sh.lines.length); tier = 0; }
    const newLines = buildOccurrence(h.body, sh.lines, pos, tier);
    const atEnd = pos + O.length >= sh.lines.length;
    sh.lines.splice(pos, O.length, ...newLines);
    if (atEnd) sh.finalBreak = !h.noNewline;
    d += h.body.filter((e) => e.kind === ' ' || e.kind === '+').length - O.length;
  }
  return sh;
}
function applyUnifiedSection(t: Tree, sec: Section): void {
  for (const p of [sec.oldPath, sec.newPath]) if (p !== '' && !safe(p)) throw new Fail('unsafe', p);
  if (sec.kind === 'create') {
    if (t.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
    const parts: string[] = []; let nn = false;
    for (const h of sec.hunks) for (const e of h.body) if (e.kind === '+') { parts.push(e.text); nn = h.noNewline; }
    t.now.set(sec.newPath, parts.join('\n') + (parts.length && !nn ? '\n' : ''));
  } else if (sec.kind === 'delete') {
    if (t.get(sec.oldPath) === null) throw new Fail('missing', sec.oldPath);
    t.now.set(sec.oldPath, null);
  } else if (sec.kind === 'move') {
    const sh = getShape(t, sec.oldPath); if (sh === null) throw new Fail('missing', sec.oldPath);
    if (t.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
    putShape(t, sec.newPath, uApplyHunks(sh, sec.hunks, sec.newPath));
    t.now.set(sec.oldPath, null);
    MOVES.push({ old: sec.oldPath, new: sec.newPath });
  } else {
    const sh = getShape(t, sec.oldPath); if (sh === null) throw new Fail('missing', sec.oldPath);
    putShape(t, sec.oldPath, uApplyHunks(sh, sec.hunks, sec.oldPath));
  }
}

interface SRBlock { path:string; oldLines:string[]; newLines:string[]; searchNum:number }
function parseSearchReplace(lines: string[]): SRBlock[] {
  const isMarker = (s: string, m: string) => s.trimEnd() === m;
  const blocks: SRBlock[] = [];
  let prevPath = '';
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (!isMarker(lines[i]!, '<<<<<<< SEARCH')) { i++; continue; }
    const searchNum = i + 1;
    let path = '';
    for (let k = i - 1; k >= searchFrom; k--) {
      const s = lines[k]!.trim();
      if (s === '' || s.startsWith('```')) continue;
      path = s; break;
    }
    if (path === '') {
      if (prevPath === '') throw new Exit2(`error: parse ${searchNum}`);
      path = prevPath;
    }
    let eqIdx = -1, repIdx = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (eqIdx < 0 && isMarker(lines[k]!, '=======')) { eqIdx = k; continue; }
      if (eqIdx >= 0 && isMarker(lines[k]!, '>>>>>>> REPLACE')) { repIdx = k; break; }
    }
    if (eqIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${searchNum}`);
    blocks.push({
      path,
      oldLines: lines.slice(i + 1, eqIdx),
      newLines: lines.slice(eqIdx + 1, repIdx),
      searchNum,
    });
    prevPath = path;
    searchFrom = repIdx + 1;
    i = repIdx + 1;
  }
  return blocks;
}
function srPositions(fl: string[], O: string[], tier: number): number[] {
  const res: number[] = [];
  const norm = (s: string) => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, ' ') : s.trim();
  const eq = (a: string, b: string) => tier === 1
    ? norm(a).replace(/[ \t]+$/, '') === norm(b).replace(/[ \t]+$/, '')
    : norm(a) === norm(b);
  for (let i = 0; i + O.length <= fl.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) { if (!eq(fl[i + j]!, O[j]!)) { ok = false; break; } }
    if (ok) res.push(i);
  }
  return res;
}
function applySRBlock(t: Tree, b: SRBlock): void {
  const { path, oldLines, newLines } = b;
  if (path !== '' && !safe(path)) throw new Fail('unsafe', path);
  if (oldLines.length === 0) {
    if (t.get(path) !== null) throw new Fail('exists', path);
    t.now.set(path, newLines.join('\n') + '\n');
  } else {
    const sh = getShape(t, path); if (sh === null) throw new Fail('missing', path);
    let tier = -1, found: number[] = [];
    for (const tt of TIERS()) { const ps = srPositions(sh.lines, oldLines, tt); if (ps.length) { tier = tt; found = ps; break; } }
    if (found.length === 0) throw new Fail('no-match', path);
    if (found.length > 1) throw new Fail('ambiguous', path);
    const entries = newLines.map((text) => ({ kind: '+', text }));
    const repl = buildOccurrence(entries, sh.lines, found[0]!, tier, lead(oldLines[0]!));
    sh.lines.splice(found[0]!, oldLines.length, ...repl);
    putShape(t, path, sh);
  }
}

function v4aNorm(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, ' ') : s.trim();
}
function v4aEq(a: string, b: string, tier: number): boolean {
  return tier === 1
    ? v4aNorm(a, 1).replace(/[ \t]+$/, '') === v4aNorm(b, 1).replace(/[ \t]+$/, '')
    : v4aNorm(a, tier) === v4aNorm(b, tier);
}
function v4aFind(fl: string[], pat: string[], from: number, eofOnly: boolean): {pos:number,tier:number}|null {
  for (const tier of TIERS()) {
    for (let i = from; i + pat.length <= fl.length; i++) {
      if (eofOnly && i + pat.length !== fl.length) continue;
      let ok = true;
      for (let j = 0; j < pat.length; j++) { if (!v4aEq(fl[i + j]!, pat[j]!, tier)) { ok = false; break; } }
      if (ok) return { pos: i, tier };
    }
  }
  return null;
}

type V4AChunk = { anchor:string; body:{kind:string,text:string}[]; eof:boolean };
type V4ASec = { kind:string; path:string; moveTo:string; body:string[]; chunks:V4AChunk[]; line:number };
function parseV4A(lines: string[]): V4ASec[] {
  const isBlank = (s: string) => s.trim() === '';
  let start = -1;
  for (let k = 0; k < lines.length; k++) if (!isBlank(lines[k]!)) { start = k; break; }
  if (start < 0 || lines[start]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${start < 0 ? 1 : start + 1}`);
  let end = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!isBlank(lines[k]!)) { end = k; break; }
  if (end < 0 || lines[end]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const secs: V4ASec[] = [];
  const isHeader = (s: string) => /^\*\*\* (Add|Delete|Update) File: /.test(s);
  let i = start + 1;
  let m: RegExpExecArray | null;
  while (i < end) {
    const line = lines[i]!;
    if (isBlank(line)) { i++; continue; }
    if ((m = /^\*\*\* Add File: (.*)$/.exec(line))) {
      const sec: V4ASec = { kind:'add', path:m[1]!.trim(), moveTo:'', body:[], chunks:[], line:i+1 };
      i++;
      while (i < end && !isHeader(lines[i]!)) {
        const b = lines[i]!;
        if (b.startsWith('+')) sec.body.push(b.slice(1));
        else if (b === '') sec.body.push('');
        else throw new Exit2(`error: parse ${i+1}`);
        i++;
      }
      secs.push(sec); continue;
    }
    if ((m = /^\*\*\* Delete File: (.*)$/.exec(line))) {
      const sec: V4ASec = { kind:'delete', path:m[1]!.trim(), moveTo:'', body:[], chunks:[], line:i+1 };
      i++;
      while (i < end && isBlank(lines[i]!)) i++;
      if (i < end && !isHeader(lines[i]!)) throw new Exit2(`error: parse ${i+1}`);
      secs.push(sec); continue;
    }
    if ((m = /^\*\*\* Update File: (.*)$/.exec(line))) {
      const sec: V4ASec = { kind:'update', path:m[1]!.trim(), moveTo:'', body:[], chunks:[], line:i+1 };
      i++;
      if (i < end && (m = /^\*\*\* Move to: (.*)$/.exec(lines[i]!))) { sec.moveTo = m[1]!.trim(); i++; }
      while (i < end && !isHeader(lines[i]!)) {
        const l = lines[i]!;
        if (l.trim() === '*** End of File') {
          if (sec.chunks.length === 0) throw new Exit2(`error: parse ${sec.line}`);
          sec.chunks[sec.chunks.length-1]!.eof = true; i++; continue;
        }
        if (l.startsWith('@@')) {
          sec.chunks.push({ anchor:l.slice(2).trim(), body:[], eof:false }); i++; continue;
        }
        if (sec.chunks.length === 0) sec.chunks.push({ anchor:'', body:[], eof:false });
        const c = sec.chunks[sec.chunks.length-1]!;
        if (l === '') { c.body.push({kind:' ',text:''}); i++; continue; }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) { c.body.push({kind:l[0]!,text:l.slice(1)}); i++; continue; }
        throw new Exit2(`error: parse ${i+1}`);
      }
      const lastChunk = sec.chunks[sec.chunks.length-1];
      if (lastChunk) while (lastChunk.body.length>0 && lastChunk.body[lastChunk.body.length-1]!.kind===' ' && lastChunk.body[lastChunk.body.length-1]!.text==='') lastChunk.body.pop();
      if (sec.chunks.length === 0 && sec.moveTo === '') throw new Exit2(`error: parse ${sec.line}`);
      secs.push(sec); continue;
    }
    throw new Exit2(`error: parse ${i+1}`);
  }
  return secs;
}

function applyV4ASection(t: Tree, sec: V4ASec): void {
  for (const p of [sec.path, sec.moveTo]) if (p !== '' && !safe(p)) throw new Fail('unsafe', p);
  {
    if (sec.kind === 'add') {
      if (t.get(sec.path) !== null) throw new Fail('exists', sec.path);
      t.now.set(sec.path, sec.body.join('\n') + '\n');
    } else if (sec.kind === 'delete') {
      if (t.get(sec.path) === null) throw new Fail('missing', sec.path);
      t.now.set(sec.path, null);
    } else {
      const sh = getShape(t, sec.path); if (sh === null) throw new Fail('missing', sec.path);
      let cursor = 0;
      for (const c of sec.chunks) {
        if (c.anchor !== '') {
          const hit = v4aFind(sh.lines, [c.anchor], cursor, false);
          if (!hit) throw new Fail('no-match', sec.path);
          cursor = hit.pos + 1;
        }
        const O = c.body.filter((e) => e.kind === ' ' || e.kind === '-').map((e) => e.text);
        const N = c.body.filter((e) => e.kind === ' ' || e.kind === '+');
        let pos: number, tier: number;
        if (O.length > 0) {
          const hit = v4aFind(sh.lines, O, cursor, c.eof);
          if (!hit) throw new Fail('no-match', sec.path);
          pos = hit.pos; tier = hit.tier;
        } else { pos = c.eof ? sh.lines.length : Math.min(cursor, sh.lines.length); tier = 0; }
        const repl = buildOccurrence(c.body, sh.lines, pos, tier, lead(O[0] ?? ''));
        sh.lines.splice(pos, O.length, ...repl);
        cursor = pos + repl.length;
      }
      if (sec.moveTo !== '') {
        if (t.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
        putShape(t, sec.moveTo, sh);
        t.now.set(sec.path, null);
        MOVES.push({ old: sec.path, new: sec.moveTo });
      } else putShape(t, sec.path, sh);
    }
  }
}

function formatEdits(kind:string, text:string, lines:string[]): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return parseUnified(lines).map((sec) => (t) => applyUnifiedSection(t, sec));
  if (kind === 'search-replace') return parseSearchReplace(lines).map((b) => (t) => applySRBlock(t, b));
  if (kind === 'v4a') return parseV4A(lines).map((sec) => (t) => applyV4ASection(t, sec));
  throw new Exit2('error: format');
}
