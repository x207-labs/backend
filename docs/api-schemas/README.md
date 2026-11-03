# Read API and settlement worker schemas

`index.json` maps each endpoint of Spec API Backend 2.1 and 2.2 to a JSON schema (draft-07) in this folder and to an example in `examples/`. The test `test/api/schemas.test.ts` (TC-BE-014-15) validates all examples and live responses.

The `examples/` files are copied from Spec API Backend sections 3–6. Deviations from the spec examples:

- `member.json` and `members-list.json` include `exitRequestedEpoch` (Addendum ADR-29..31 in the spec).
- The spec gives no examples for `epochs-list`, `member-limits`, and `params-history`. The item shape is derived from the D9 columns (Spec Skema D9 3.4, 6.1, 6.7) in camelCase; `epochs-list` must include `epoch`, `phase`, `proposalDeadline` (K-41).
- `proposals`, `intents`, `bundles` do not have schemas yet: the format awaits BE-023 and SD-047.
- The intent/signedIntent examples are synthetic; the real shape is determined by the 1Click SDK 0.1.26.

The `cutoff` and `commit` phases of the epoch `phase` are derived from the time of reading (`cutoff_at`, `proposal_deadline`), while D9 stores only four phases.
