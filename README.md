# mend-patch-tool

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/salahhamza332/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/salahhamza332/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line patch applier for the edits AI models write. It reads a patch in one of four formats — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace, leading and trailing whitespace), and writes every change atomically: all edits or none. It uses only Node.js 22 and its standard library.

`SPEC.md` is the complete specification this entry implements. The public practice set is 100 checks; the scored phase uses 300 sealed checks.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file relative to the working directory; omit it or pass `-` to read the patch from standard input. `--format` selects `auto` (default), `unified`, `search-replace`, `v4a` or `json`. `--check` reports what would change without writing anything, and `--strict` matches lines exactly. For example:

```sh
node main.ts fix.patch
cat changes.diff | node main.ts --format=unified -
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8tndrygv&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
