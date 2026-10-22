# The compatibility suite and the pinned reference

The compatibility suite runs the **real gateway of Shuttle**, unchanged,
against Hub. The gateway is a reference: a checkout of another
repository, at a commit that is pinned, that is never modified.

This document is the manual of the runner: where the pin lives, how to
run the suite, how to move the pin, and what happens when something is
wrong.

## The pin

The pin is the file `compatibility.json` at the root of this repository.
It is the only place where the reference is named:

```json
{
  "version": 1,
  "repositories": {
    "shuttle": {
      "url": "https://github.com/ggpwnkthx/shuttle.git",
      "commit": "3744b7fa7c2649083dc569965934b9580ab15c02"
    }
  }
}
```

The format is checked by the runner, and it is deliberately strict:

- `version` is `1`. A manifest of another version is refused.
- `url` is the repository of the reference. It is a git url, and it is
  never interpolated in a shell: every command is an argument array.
- `commit` is a **full commit id**: forty hexadecimal characters. A
  branch, a tag, a short hash or a placeholder is refused, because a
  reference that moves is a reference that cannot be tested twice.

There is no second pin. The CI workflow does not carry a url and a
commit of its own: it reads the manifest, like the runner and like a
developer do.

The pin is a commit that is **published**: a fresh checkout has to be
able to obtain it from the canonical repository of the reference. A
commit that exists only in a working tree is not a pin, and a commit
that is not the head of the default branch is a deliberate choice, not
an accident.

The revision that Hub is tested against is the head of the default
branch of the gateway, and the commit of the release `v0.5.0` of it.

## Running the suite

A fresh checkout of this repository runs the real compatibility suite
with one command:

```bash
bun install --frozen-lockfile
bun run test:compat
```

The command does everything:

1. it reads `compatibility.json` relatively to the root of the
   repository, whatever the directory the command runs in is;
2. it clones the gateway of the reference into a temporary directory and
   checks out the pinned commit — the whole history is cloned, because the
   pinned commit is not always the one of the default branch, and the
   default branch of a source is not the business of the runner;
3. it installs the dependencies of the reference with
   `bun install --frozen-lockfile`, in the directory of the reference
   itself;
4. it runs `bun test test/compatibility` with the path of the checkout in
   `HUB_SHUTTLE_PATH`: the gateway of the reference runs as a process, in
   its own directory, with its own configuration;
5. it checks that the reference is at the pinned commit and that its
   tracked files are the ones of the commit, before and after the run;
6. it removes the temporary checkout.

The runner prints the revision it tested:

```
the reference is cloned from the manifest (https://github.com/ggpwnkthx/shuttle.git) at 3744b7fa7c2649083dc569965934b9580ab15c02
the reference is at 3744b7fa7c2649083dc569965934b9580ab15c02 and its tracked files are the ones of the commit
the reference is unchanged: it is still 3744b7fa7c2649083dc569965934b9580ab15c02
the compatibility suite passed against the gateway at 3744b7fa7c2649083dc569965934b9580ab15c02 (the manifest (https://github.com/ggpwnkthx/shuttle.git))
```

The revision is a commit, not a branch: the
[baseline of the integration](https://github.com/ggpwnkthx/shuttle/tree/3744b7fa7c2649083dc569965934b9580ab15c02)
is the exact code that Hub is tested against, and the
[repository of the gateway](https://github.com/ggpwnkthx/shuttle) is
where it lives.

## The tests of this repository, and the compatibility suite

The two are separate, and the split is explicit:

| Command | What it runs |
| --- | --- |
| `bun run test` | The tests of **this** repository: the units, the contracts, the integrations, the boundaries and the tooling. It needs no gateway and no sibling directory. |
| `bun run test:compat` | The compatibility suite: the real gateway of the reference, unchanged, against Hub. |
| `bun run test:all` | The two, one after the other. |

`bun test` alone, without an argument, also collects the compatibility
suite, and the suite then fails with a message that says how to prepare
the reference. It is `bun run test` that a developer runs every day.

## The sources of the reference

The runner reads its source from the environment. The order is the one
of the list below: **the first one that is set wins.**

| Variable | What it is |
| --- | --- |
| `HUB_SHUTTLE_PATH` | A checkout of the gateway that is already prepared. It is used as it is: the runner never resets it, never cleans it and never checks out over it. |
| `SHUTTLE_REPOSITORY` | The repository of the gateway: a git url, or the path of a local repository. It has to hold the pinned commit. Its default branch is irrelevant. |
| `COMPAT_MIRROR` | A directory that holds a bare repository named `shuttle.git`. It is the way to run the suite without the network. |
| — | The url of the manifest: the canonical source. |

Two variables are about the run itself:

| Variable | What it is |
| --- | --- |
| `COMPAT_WORKSPACE` | The directory the checkout is created in. It is a temporary directory by default. |
| `COMPAT_KEEP` | When it is set, the checkout is kept after the run: the tree of the reference is then inspected by hand. |

### A prepared checkout

```bash
git clone https://github.com/ggpwnkthx/shuttle.git /tmp/shuttle
git -C /tmp/shuttle checkout --detach 3744b7fa7c2649083dc569965934b9580ab15c02
HUB_SHUTTLE_PATH=/tmp/shuttle bun run test:compat
```

The runner **checks** the checkout before it uses it: its `HEAD` has to
be the pinned commit, and its tracked files have to be the ones of the
commit. A checkout that is at another commit, or that carries changes,
is refused with the reason. The tree of a developer is never written to:
the runner only installs the dependencies of the reference in it, and
the dependencies are not tracked.

### A local repository

```bash
SHUTTLE_REPOSITORY=/path/to/shuttle bun run test:compat
```

The local repository is cloned, not used as it is: the checkout of the
runner is a fresh one at the pinned commit, and the tree of the source
is never touched. The source has to hold the pinned commit — a
repository whose default branch moved away from the pin is refused with
the name of the commit it does not hold.

### A mirror, without the network

```bash
mkdir -p /srv/compat-mirror
git clone --bare https://github.com/ggpwnkthx/shuttle.git /srv/compat-mirror/shuttle.git
COMPAT_MIRROR=/srv/compat-mirror bun run test:compat
```

The mirror is a bare repository named after the reference. The same
convention is used by the harness of
[Depot](https://github.com/ggpwnkthx/depot), so a mirror that serves one
serves the other.

## When it fails

An override that is set and that cannot be used is an **error**: the
runner never falls back to another source, because a suite that runs
against another revision is a suite that proves nothing.

| Situation | What the runner says |
| --- | --- |
| The prepared checkout is at another commit | `the prepared checkout … is at … and the pin is …: the checkout has to be at the pinned commit` |
| The prepared checkout carries changes | `the prepared checkout … carries changes to its tracked files:` and the list of the changes |
| The source does not hold the pinned commit | `the source … does not hold the commit …` |
| The clone failed | `the clone of … failed:` and the output of git, with the two ways to give another source |
| The mirror holds no `shuttle.git` | `COMPAT_MIRROR names a directory that holds no bare repository named "shuttle.git": …` |
| The suite failed | The output of the suite, and the status of the suite is the status of the runner. |
| The reference was modified during the run | `the suite modified the tracked files of the reference:` and the list of the changes |

The temporary checkout is removed when the run fails and when the run is
interrupted. A checkout that a developer supplied is never removed.

## Moving the pin

The pin moves when the gateway of the reference moves, and it moves with
a commit, never with a branch.

1. Choose the commit of the gateway that Hub is tested against. It is
   the head of the default branch of
   [the repository of the gateway](https://github.com/ggpwnkthx/shuttle),
   or a release of it. The commit has to be **published** there: a
   checkout that only exists in a working tree cannot be the pin of a
   repository that a fresh clone has to be able to prepare.
2. Write its **full** commit id in `compatibility.json`.
3. Run the suite:

   ```bash
   bun run test:compat
   ```

   The runner prints the revision it tested, and the suite fails if the
   gateway of that revision does not speak the contract of Hub.
4. Commit the manifest with the change, in a commit that says why the
   pin moved.

A change of the gateway that breaks the suite is a change of the
contract: it is fixed in the gateway, in its own repository, and the pin
is moved afterwards. **The checkout of the reference is never modified
to make a test pass**, and the authorization rules of Hub are never
changed to make a compatibility test pass.

## What the CI does

The job `compatibility` of `.github/workflows/ci.yml` runs
`bun run test:compat`, and it keeps the checkout to assert, in a second
step, that the tree of the reference is the one of the pinned commit.
The job reads the pin in the manifest: it carries no url and no commit
of its own.

The job is **blocking**: a red compatibility job is a red build,
whatever the rest says.
