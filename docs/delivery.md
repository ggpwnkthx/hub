# The delivery of Hub

The image of Hub is built once and promoted by its digest. Nothing is
rebuilt between the environments: the image that was tested is the image
that runs.

## The build

```bash
docker build -f Dockerfile -t hub:$(git rev-parse --short HEAD) \
  --build-arg REVISION=$(git rev-parse HEAD) \
  --build-arg VERSION=$(node -p "require('./package.json').version") .
```

The labels of the image carry the version and the revision, so an
operator knows what is running without reading the logs:

```bash
docker image inspect hub:<tag> --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

The base image is pinned by digest (`oven/bun:1.4.3-alpine@sha256:…`): a
tag is a name that moves, and the image of a release has to be the image
that was built, scanned and promoted.

## The scan and the SBOM

The CI builds the image, scans it and writes its SBOM. A finding of a
severity above "high" fails the build:

```bash
trivy image --severity HIGH,CRITICAL --exit-code 1 hub:ci
syft hub:ci -o spdx-json > hub.spdx.json
```

The SBOM is published with the image: the deployment knows what it runs.

## The promotion

| Stage | What happens |
| --- | --- |
| The commit | The branch is merged when the CI is green, the exit criteria of the milestone are checked, and the specification is changed if the milestone changed a rule. |
| The review | One reviewer other than the author. The checklist of the review is in [IMPLEMENTATION.md](../IMPLEMENTATION.md) §9.1. |
| The image | The image is built once, tagged with the commit and pushed with its digest. **The digest is what is deployed.** |
| The promotion | The same digest goes from the development environment to the staging one and from the staging one to the production one. Nothing is rebuilt in between. |
| The deployment | A rolling replacement of the replicas, with the readiness probe as the gate. The drain of a replica takes the logins in flight with it. |
| The rollback | The previous digest is deployed again. The service is stateless except for the database, and the migrations are backward compatible for one release: a rollback of the image does not need a rollback of the schema. |

## The drain

On `SIGTERM` the replica answers `503 draining` to its readiness, stops
accepting new work, gives the running logins five seconds and exits. The
replacement of a replica waits for it: the deployment gives it the grace
period of the drain (10 s) and the rollout waits for the pod to be gone.

## The rollback

```bash
kubectl -n hub rollout undo deployment/hub
kubectl -n hub rollout status deployment/hub
```

The rollback is rehearsed: a deployment that was never rolled back is a
deployment that does not know how to roll back.

## The check of the delivery

The CI of the repository runs, on every push:

| Job | What it runs |
| --- | --- |
| `check` | The types, the lint, the format, the import boundaries and the tests. |
| `compatibility` | The gateway of the reference, unchanged, against Hub, and the proof that the tree of the reference is the one of `shuttle.ref`. |
| `image` | The build of the image, the user it runs as, its size, its refusal to start without a secret, its start with a deployment and its drain. |
