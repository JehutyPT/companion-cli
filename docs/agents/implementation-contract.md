# Implementation Contract

The `## Implementation Contract` section in the issue body or local ticket file is the sole implementation authority. Edit that section in place as the contract is prepared. Metadata and context may remain elsewhere in the body; parent PRDs, dependency issues, comments, and surrounding body content never supersede the contract section.

## Required section

Use this exact shape. Put one freshness anchor directly under `## Implementation Contract`:

- `**Validated against:** <default-branch commit SHA>` for a prepared contract eligible for readiness.
- `**Drafted against:** <default-branch commit SHA>` for a provisional contract awaiting preparation.

Then use every heading below:

```markdown
## Implementation Contract

**Validated against:** <default-branch commit SHA>

### Outcome

The observable behavior this ticket must deliver.

### Acceptance criteria

- [ ] Concrete, independently checkable criterion.

### Scope boundaries

- Included behavior and explicit exclusions.

### Dependency assumptions

- #<upstream>: the landed behavior this contract relies on.
- None, when the ticket has no upstream dependency.

### Verification

**Claim:** The behavior or invariant that completion must prove.

**Preferred evidence:** The highest stable test seam or other allowed evidence that proves the claim.
```

Make completion explicit: every acceptance criterion is satisfied and every verification claim has its preferred evidence or a documented allowed substitute.

Describe stable behavior, interfaces, and decisions. Omit file paths and line numbers unless the location itself is part of the contract.

Repositories may strengthen Verification with additional required fields. Record those fields in this scaffold and require every producer and consumer skill to preserve them.

## Relationships and gating

Represent parent and blocker relationships with the tracker's formal edges. Retain blocker edges after upstream work closes. Only open blockers gate preparation or implementation; closed edges remain provenance.

Repeat each upstream dependency under `Dependency assumptions` with the behavior expected from it. A closed edge proves only that work closed, not that the assumed behavior landed.

Apply internal readiness only as the final mutation after confirming the item is open, has zero open blockers, has a complete canonical section, and is validated against landed default-branch behavior. A later default-branch SHA alone does not invalidate a contract; inspect whether relevant intervening changes cause material drift.
