# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/airdropgodx24/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/airdropgodx24/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single dependency-free Node process. It serves git smart-HTTP (protocol v2 ls-refs and fetch with shallow support, plus the v0 fallback and receive-pack pushes with per-ref report-status), the REST v3 API (repositories, contents, the Git Data API, labels, issues and pull requests with squash merges), a GraphQL v4 endpoint with Relay-style global ids, cursor pagination and introspection, and an MCP server speaking both the 2026-07-28 discover handshake and the legacy initialize flow — all four surfaces over one shared in-memory store, so an object created through any surface reads back identically through the others.

Everything is deterministic: a logical clock and sequential numeric ids stand in for wall-clock time and randomness, git objects are content-addressed SHA-1 with hand-rolled packfile reading and writing (delta resolution included), and the process binds an ephemeral port, registers it with the suite environment, and exits cleanly when the suite reports done.

## Run it

```sh
node main.ts
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=ty7xpzdw&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
