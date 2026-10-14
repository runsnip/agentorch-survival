# AgentOrch · Đảo sinh tồn (Survival Island)

A free first-person survival game add-on for [AgentOrch](https://github.com/runsnip/agentorch), played from
the CEO's desk (P). Everyone drops in empty-handed on one of three islands, loots weapons and gear, and
fights inside a shrinking safe zone; the last one standing wins. One of the bots can be played by an
agent of your company, as an opponent, for very few tokens.

- outfits bought with the coins your company's token use earns, or unlocked by inventory items
- the company's inventory comes along: gun finishes, starters to bring into a match
- low windows to climb through, no looting through walls

Install it from the app: **Tab › Giải trí › Đảo sinh tồn › Tải về**.

## Development

Plain ES modules loaded by AgentOrch (`manifest.json` says which host API it needs). Dev pages under
`dev/` (e.g. `dev/play.html?play=1`) run the game with a fake bridge when served by the app's web server
(`/addons/arena/dev/...`).

    python3 tools/pack.py                         # dist/arena.zip + .sha256
    AGENTORCH_ARENA_URL=file://$PWD/dist/arena.zip python -m agentorch

A release is a tag `v<version>` matching `manifest.json`; the workflow attaches the pack to the release.

## License

Code: Apache-2.0 — see [LICENSE](LICENSE). Third-party assets keep their own licences, listed in
[NOTICE](NOTICE).
