"""THROWAWAY spike prototype (card #1). Not product code: see spike/README.md.

Parses Junos hierarchical ("curly brace") config into a tree, then prints the
equivalent of `show configuration | display set`. Also a rough set -> curly
reverse that shows why the reverse needs the Junos schema.

Usage:
    python -I junos_set.py FILE            # curly -> set
    python -I junos_set.py --reverse FILE  # set -> curly (heuristic, see below)
    python -I junos_set.py --selftest
    python -I junos_set.py --compare DIR   # DIR holds config_N.txt + config_N_set.txt pairs
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

MODIFIERS = {"inactive:", "protect:", "replace:"}
SPECIAL = set("{};[]")


class ParseError(Exception):
    def __init__(self, msg: str, line: int, col: int):
        super().__init__(f"line {line}, col {col}: {msg}")
        self.line, self.col = line, col


@dataclass
class Tok:
    kind: str  # WORD, LBRACE, RBRACE, SEMI, LBRACK, RBRACK, ANNOT
    text: str
    line: int
    col: int


def tokenize(src: str) -> list[Tok]:
    toks: list[Tok] = []
    i, line, col, n = 0, 1, 1, len(src)

    def adv(k: int = 1) -> None:
        nonlocal i, line, col
        for _ in range(k):
            if src[i] == "\n":
                line, col = line + 1, 1
            else:
                col += 1
            i += 1

    while i < n:
        c = src[i]
        if c in " \t\r\n":
            adv()
        elif c == "#":  # '## Last commit', '## SECRET-DATA': comment to end of line
            while i < n and src[i] != "\n":
                adv()
        elif src.startswith("/*", i):
            sl, sc = line, col
            end = src.find("*/", i + 2)
            if end < 0:
                raise ParseError("unterminated /* annotation */", sl, sc)
            text = src[i + 2:end].strip()
            adv(end + 2 - i)
            toks.append(Tok("ANNOT", text, sl, sc))
        elif c in SPECIAL:
            kind = {"{": "LBRACE", "}": "RBRACE", ";": "SEMI", "[": "LBRACK", "]": "RBRACK"}[c]
            toks.append(Tok(kind, c, line, col))
            adv()
        else:
            sl, sc, start = line, col, i
            while i < n and src[i] not in " \t\r\n" and src[i] not in SPECIAL:
                if src[i] == '"':
                    adv()
                    while i < n and src[i] != '"':
                        if src[i] == "\\" and i + 1 < n:
                            adv()
                        adv()
                    if i >= n:
                        raise ParseError("unterminated quoted string", sl, sc)
                adv()
            toks.append(Tok("WORD", src[start:i], sl, sc))
    return toks


@dataclass
class Node:
    words: list[str]
    line: int
    children: list[Node] | None = None  # None = leaf statement
    values: list[str] | None = None  # leaf with a [ list ]
    inactive: bool = False
    protect: bool = False
    replace: bool = False
    annotation: str | None = None


@dataclass
class Result:
    nodes: list[Node]
    warnings: list[str] = field(default_factory=list)


def parse(src: str) -> Result:
    toks = tokenize(src)
    pos = 0
    warnings: list[str] = []

    def peek() -> Tok | None:
        return toks[pos] if pos < len(toks) else None

    def body(depth: int) -> list[Node]:
        nonlocal pos
        nodes: list[Node] = []
        pending_annot: str | None = None
        while True:
            t = peek()
            if t is None:
                if depth:
                    raise ParseError("missing '}' at end of input", toks[-1].line, toks[-1].col)
                return nodes
            if t.kind == "RBRACE":
                if not depth:
                    raise ParseError("unexpected '}'", t.line, t.col)
                pos += 1
                return nodes
            if t.kind == "ANNOT":
                pending_annot = t.text
                pos += 1
                continue
            node = statement()
            node.annotation, pending_annot = pending_annot, None
            nodes.append(node)

    def statement() -> Node:
        nonlocal pos
        first = peek()
        node = Node([], first.line)
        while (t := peek()) is not None and t.kind == "WORD" and t.text in MODIFIERS:
            setattr(node, t.text[:-1], True)
            pos += 1
        while (t := peek()) is not None and (t.kind == "WORD" or (t.kind == "ANNOT" and node.words)):
            if t.kind == "ANNOT":  # redacted secret: `encrypted-password /* SECRET-DATA */;`
                node.words.append(f"/* {t.text} */")
                pos += 1
                continue
            if t.text.endswith(":") and t.text[:-1].isalpha() and not node.words:
                warnings.append(f"line {t.line}: unknown tag '{t.text}' kept as a word")
            node.words.append(t.text)
            pos += 1
        if t is None:
            raise ParseError("statement not terminated", first.line, first.col)
        if not node.words:
            raise ParseError(f"expected a statement, got '{t.text}'", t.line, t.col)
        if t.kind == "SEMI":
            pos += 1
        elif t.kind == "LBRACE":
            pos += 1
            node.children = body(1)
        elif t.kind == "LBRACK":
            pos += 1
            node.values = []
            while (v := peek()) is not None and v.kind == "WORD":
                node.values.append(v.text)
                pos += 1
            if v is None or v.kind != "RBRACK":
                raise ParseError("expected ']'", *(first.line, first.col) if v is None else (v.line, v.col))
            pos += 1
            if (s := peek()) is None or s.kind != "SEMI":
                raise ParseError("expected ';' after ']'", v.line, v.col)
            pos += 1
        else:
            raise ParseError(f"unexpected '{t.text}'", t.line, t.col)
        return node

    nodes = body(0)
    return Result(nodes, warnings)


def to_set(nodes: list[Node], path: list[str] | None = None, out: list[str] | None = None) -> list[str]:
    # Ordering follows Juniper's documented `display set` example: a statement's
    # `deactivate`/`protect` comes after the `set` lines of its whole subtree
    # (Junos can't deactivate a hierarchy that doesn't exist yet). jcc's
    # fixtures and Batfish put a container's `deactivate` first instead.
    path = path or []
    out = [] if out is None else out
    for nd in nodes:
        full = " ".join(path + nd.words)
        if nd.children is None:
            if nd.values is not None:
                out.extend(f"set {full} {v}" for v in nd.values)
            else:
                out.append(f"set {full}")
            if nd.inactive:
                out.append(f"deactivate {full}")
            if nd.protect:
                out.append(f"protect {full}")
        else:
            if not nd.children:
                out.append(f"set {full}")
            to_set(nd.children, path + nd.words, out)
            if nd.inactive:
                out.append(f"deactivate {full}")
            if nd.protect:
                out.append(f"protect {full}")
    return out


def annotations(nodes: list[Node], path: list[str] | None = None) -> list[str]:
    path = path or []
    found = []
    for nd in nodes:
        if nd.annotation is not None:
            found.append(f"line {nd.line}: /* {nd.annotation} */ on '{' '.join(path + nd.words)}'")
        if nd.children:
            found += annotations(nd.children, path + nd.words)
    return found


def reverse(set_text: str) -> str:
    """Heuristic set -> curly. Without the Junos schema it cannot know that
    `unit 0` is one node or that `vlan-id-list` takes a [ list ], so it
    folds single-child chains onto one line. Shown here to make that point."""
    root: dict = {}
    inactive: set[tuple[str, ...]] = set()
    for raw in set_text.splitlines():
        if not raw.strip():
            continue
        words = [t.text for t in tokenize(raw)]
        verb, rest = words[0], tuple(words[1:])
        if verb == "deactivate":
            inactive.add(rest)
            continue
        if verb != "set":
            continue
        cur = root
        for w in rest:
            cur = cur.setdefault(w, {})
        cur[None] = True  # terminal marker

    lines: list[str] = []

    def render(tree: dict, path: tuple[str, ...], indent: int) -> None:
        for key, sub in tree.items():
            if key is None:
                continue
            chain, p = [key], path + (key,)
            while len([k for k in sub if k is not None]) == 1 and None not in sub and p not in inactive:
                (nxt,) = [k for k in sub if k is not None]
                chain.append(nxt)
                sub, p = sub[nxt], p + (nxt,)
            tag = "inactive: " if p in inactive else ""
            pad = "    " * indent
            kids = {k: v for k, v in sub.items() if k is not None}
            if not kids:
                lines.append(f"{pad}{tag}{' '.join(chain)};")
            else:
                lines.append(f"{pad}{tag}{' '.join(chain)} {{")
                render(kids, p, indent + 1)
                lines.append(f"{pad}}}")

    render(root, (), 0)
    return "\n".join(lines)


SELFTEST = [
    ("leaf, CRLF, tabs", "system {\r\n\thost-name r1;\r\n}\r\n", ["set system host-name r1"]),
    ("no trailing newline", "version 21.4R3;", ["set version 21.4R3"]),
    ("annotation not in output", "system {\n    /* mgmt */\n    host-name r1;\n}\n", ["set system host-name r1"]),
    ("quoted with ; { and escaped quote",
     'interfaces {\n    ge-0/0/0 {\n        description "a; {b} \\"c d\\"";\n    }\n}\n',
     ['set interfaces ge-0/0/0 description "a; {b} \\"c d\\""']),
    ("list", "vlans {\n    v10 {\n        vlan-id-list [ 10 20 ];\n    }\n}\n",
     ["set vlans v10 vlan-id-list 10", "set vlans v10 vlan-id-list 20"]),
    ("'set' inside a name",
     "firewall {\n    filter F {\n        inactive: term block-reset {\n            then {\n                inactive: reject tcp-reset;\n            }\n        }\n    }\n}\n",
     ["set firewall filter F term block-reset then reject tcp-reset",
      "deactivate firewall filter F term block-reset then reject tcp-reset",
      "deactivate firewall filter F term block-reset"]),
    ("inactive stanza: deactivate after its subtree (Juniper's documented example)",
     "interfaces {\n    xe-0/0/0 {\n        inactive: unit 1 {\n            family inet {\n                address 10.0.0.1/8;\n            }\n        }\n    }\n}\n",
     ["set interfaces xe-0/0/0 unit 1 family inet address 10.0.0.1/8",
      "deactivate interfaces xe-0/0/0 unit 1"]),
    ("leading underscore and @", "system {\n    host-name _r1;\n    location @lab;\n}\n",
     ["set system host-name _r1", "set system location @lab"]),
    ("empty container", "interfaces {\n    ge-0/0/1 {\n    }\n}\n", ["set interfaces ge-0/0/1"]),
]

SELFTEST_ERRORS = [
    ("unterminated quote", 'system {\n    host-name "r1;\n}\n'),
    ("missing brace", "system {\n    host-name r1;\n"),
    ("stray brace", "}\n"),
]


def selftest() -> int:
    bad = 0
    for name, src, want in SELFTEST:
        got = to_set(parse(src).nodes)
        ok = got == want
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"\n  want {want}\n  got  {got}"))
    for name, src in SELFTEST_ERRORS:
        try:
            parse(src)
            print(f"FAIL {name}: no error raised")
            bad += 1
        except ParseError as e:
            print(f"ok   {name}: {e}")
    print("reverse demo (note vlan-id-list and unit 0):")
    print(reverse("set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/24\n"
                  "set interfaces ge-0/0/0 unit 0 description x\n"
                  "set vlans v10 vlan-id-list 10\nset vlans v10 vlan-id-list 20\n"))
    return 1 if bad else 0


def compare(d: Path) -> int:
    bad = 0
    for cfg in sorted(d.glob("config_*.txt")):
        if cfg.stem.endswith("_set"):
            continue
        want = [ln.rstrip() for ln in cfg.with_name(cfg.stem + "_set.txt").read_text().splitlines() if ln.strip()]
        try:
            got = to_set(parse(cfg.read_text()).nodes)
        except ParseError as e:
            bad += 1
            print(f"ERR  {cfg.name}: {e}")
            continue
        if got == want:
            print(f"ok   {cfg.name} ({len(want)} lines)")
        elif sorted(got) == sorted(want):
            moved = sum(a != b for a, b in zip(got, want))
            print(f"ORD  {cfg.name} ({len(want)} lines): same lines, {moved} in a different order "
                  "(jcc puts a stanza's deactivate/protect before its subtree)")
        else:
            bad += 1
            diff = next((i for i, (a, b) in enumerate(zip(got, want)) if a != b), min(len(got), len(want)))
            print(f"DIFF {cfg.name}: first difference at line {diff + 1}\n"
                  f"  ours:     {got[diff] if diff < len(got) else '<end>'}\n"
                  f"  expected: {want[diff] if diff < len(want) else '<end>'}")
    return 1 if bad else 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["--selftest"]:
        return selftest()
    if argv[:1] == ["--compare"]:
        return compare(Path(argv[1]))
    if argv[:1] == ["--reverse"]:
        print(reverse(Path(argv[1]).read_text()))
        return 0
    try:
        res = parse(Path(argv[0]).read_text())
    except ParseError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print("\n".join(to_set(res.nodes)))
    for w in res.warnings + [f"annotation not shown: {a}" for a in annotations(res.nodes)]:
        print(f"warning: {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
