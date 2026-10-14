# THROWAWAY spike code

Everything under `spike/` is throwaway prototype code written for card #1
(the desktop-app spike). It is not product code: no tests, no packaging, no
support. It exists only to back up claims in `docs/spike-desktop-app.md`.
Delete it, or rewrite it properly, when the real build starts.

- `display_set/junos_set.py`: stdlib-only Junos hierarchical config parser
  (tokenizer + tree) that prints `display set` output, plus a rough
  set → hierarchical reverse. Run `python -I junos_set.py --selftest`.
