<!--
Keep this short. The goal is that a reviewer can skim it in 30 seconds and know
why the change exists and what to look at carefully.
-->

## Why

<!-- What problem does this solve? One or two sentences on the motivation. -->

## What changed

<!--
Describe the approach and the key decisions, not the file list - the diff already
lists the files. Call out anything surprising: trade-offs, temporary workarounds,
or areas where you want careful review.
-->

## Verification

<!--
How do you know it works? Paste the commands you ran and their result. Remember
that every package is verified from its own directory, e.g.

    cd templates/skills/forge-workflow-engine
    npm run typecheck
    npm test
-->

- [ ] `npm run typecheck` passes in every package I touched
- [ ] `npm test` passes in every package I touched
- [ ] CI is green

## Repository conventions

<!--
See AGENTS.md. Tick what applies, or write N/A - do not delete the section.
`npm run check:version` (from scripts/forge-launcher) enforces the first two.
-->

- [ ] Added a new `## <Month> <Year> - v<ver>` section at the top of `docs/updates.md`
- [ ] Bumped the `**Latest:**` line in `README.md` to match
- [ ] Added an ADR under `docs/adr/` for anything notable, and updated the "latest ADR" reference in `AGENTS.md`
- [ ] Updated the relevant `SKILL.md` / deep-dive docs alongside the code
- [ ] No `node_modules/` or `dist/` in the diff
