name: The change of Hub
description: What the pull request changes, and the contract it changes with it.

body:
  - type: markdown
    attributes:
      value: |
        A change of behaviour is a change of `docs/spec.md` first, in the
        same commit as the code. The guide is in `CONTRIBUTING.md`.

  - type: textarea
    id: what
    attributes:
      label: What this pull request changes
      description: What the service does after the change, in two or three sentences.
    validations:
      required: true

  - type: textarea
    id: contract
    attributes:
      label: The contract it changes
      description: |
        The sections of `docs/spec.md` that this change touches, and the
        change of the behaviour itself. Write "none" when the behaviour
        does not change.
    validations:
      required: true

  - type: textarea
    id: tests
    attributes:
      label: The tests
      description: The tests that prove the new behaviour, and the rule of the specification they hold.
    validations:
      required: true

  - type: checkboxes
    id: checks
    attributes:
      label: The checks
      options:
        - label: The specification is changed first, in this pull request, when the behaviour changes.
          required: true
        - label: `bun run test` passes.
        - label: `bun run test:compat` passes, when the gateway of the reference is touched.
        - label: `CHANGELOG.md` names the change of the contract, when there is one.
