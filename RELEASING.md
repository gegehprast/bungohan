# Releasing

Eleven packages go to npm under the `@bungohan` scope, all at **one version**
(lockstep). `@bungohan/codegen` is not published yet — its targets are the
deferred C# and Godot clients — and every app and docs example is `private`.

| | |
|---|---|
| Published | result, types, state, schema, serializer, transport, store, backplane, core, client-js, testing |
| First version | `0.1.0-alpha.1` |
| dist-tag | `alpha`, and `latest` too until a stable version exists |
| Order | the order in [`scripts/packages.ts`](scripts/packages.ts) — a package is published after everything it depends on |

## How it is built and packed

The monorepo runs on raw TypeScript: packages resolve through the workspace
symlinks to `src/index.ts`, and no build is needed to run tests, the apps or
the docs examples. That's why `packages/*/package.json` still points `main`
and `exports` at `./src`, and why the *published* entry points live in
`publishConfig`.

**Neither `bun pm pack` nor `npm pack` applies `publishConfig`.** A tarball
packed by either still claims `"main": "./src/index.ts"` — a file it does not
contain. So `bun run pack` applies it, resolves `workspace:*` and `catalog:`
to exact versions, rewrites the READMEs' relative links to absolute GitHub
URLs, stages `dist` + `README.md` + `LICENSE`, and packs *that*.

The consequence, and the one rule that matters here:

> **Publish the tarball, never a package directory.** `bun publish` from
> inside `packages/core` would publish a manifest pointing at source that
> isn't in the tarball. Each package carries a `prepublishOnly` guard that
> refuses it.

`bun run build` compiles with TypeScript 7 (`tsc`): ESM JavaScript, `.d.ts`
that keep the JSDoc, and source maps with the TypeScript inlined (`src/` is
not shipped). Each package is compiled against its siblings' *built*
declarations, so the emitted types are checked the way an installed copy
sees them. Relative specifiers get an explicit `.js` afterwards, which is
what makes the output valid under `node16` resolution and not only under a
bundler.

## One copy of `@bungohan/state`

Two copies mean two `Schema` classes, which splits `instanceof` and the
schema registry, and state silently stops syncing (spec §6.10). So:

- `@bungohan/state` is an **exact-version peer dependency** of `core`,
  `client-js` and `schema` — `"0.1.0-alpha.1"`, not a range. A range would
  let two satisfying versions coexist; an exact pin turns a mismatch into an
  install error.
- Every other internal dependency is pinned exactly too, so resolvers
  dedupe to one copy of everything.
- `bun run check:pack` installs the tarballs into a fresh project and fails
  unless the lockfile *and* `node_modules` hold exactly one.

This is why the release is lockstep: a package bumped on its own would no
longer satisfy its siblings' exact pins.

## Release checklist

### 1. Bump

Every published package moves to the same version, and the exact
`@bungohan/state` peer ranges move with it.

```sh
bun run version 0.1.0-alpha.2     # writes the manifests; --dry-run to preview
```

It also rewrites the version named in `README.md`,
`docs/getting-started.md`, `packages/core/README.md` and
`packages/client-js/README.md` (the list is `VERSION_NOTES` in
`scripts/packages.ts`). The READMEs ship in the tarballs and npm renders them from there, so
they have to be right before step 5, not after. `scripts/release-docs.test.ts`
fails if one of them drifts from the manifests.

### 2. Verify and commit

```sh
bun run verify
git commit -am "chore: release v0.1.0-alpha.2"
```

All eight checks, including `check:pack`. Don't substitute a subset. If
Valkey/Redis, Chromium or Firefox genuinely isn't available, pass
`--no-redis` / `--no-browser` / `--no-firefox`; they show as SKIPPED and the
release notes should say so.

Commit the bump on its own, before publishing: it's the commit step 6 tags,
so the tag points at manifests that carry the version that went to npm.
Feature work belongs in earlier commits, and `-a` is only safe when the bumped
manifests are the sole changes in the tree.

### 3. Build, pack and smoke-test

`bun run check:pack` already does all three, and is the gate. It builds,
packs, serves the tarballs from a throwaway local registry, installs them
into a project **outside** this repo, and proves that a Bun server starts and
accepts a join, a client joins it and receives state, the harness runs a
test, the browser entry bundles with Vite and with `bun build
--target=browser` pulling in no server code, the published `.d.ts` typecheck
under TypeScript 7 *and* the latest 5.x, the JSDoc survived declaration
emit, no `workspace:`/`catalog:` reached a manifest, and exactly one
`@bungohan/state` is installed.

To look at a tarball by hand:

```sh
bun run build && bun run pack
tar -tzf .pack/bungohan-core-0.1.0-alpha.1.tgz
tar -xzOf .pack/bungohan-core-0.1.0-alpha.1.tgz package/package.json
```

### 4. Dry-run the publish

```sh
bun run publish:dry
```

It prints, for every tarball in dependency order, the exact `bun publish`
command that would run, and runs each with `--dry-run`. Nothing is uploaded
and no login is needed to read the output — a dry run against a registry you
aren't logged into will report an auth error, which is expected.

### 5. Publish

You must be logged in (`bunx npm login`) and the `@bungohan` scope must
exist on your account or org.

```sh
bunx npm login
bun run publish:alpha             # bun publish <tarball> --tag alpha --access public, in order,
                                  # then points latest at the same version
```

Publish **in dependency order** — the order `scripts/packages.ts` lists.
npm rejects a package whose dependencies don't exist yet only at install
time, not at publish time, so a wrong order leaves a window in which
`bun add @bungohan/core` fails.

Then, while the release is a prerelease and no stable version is on npm,
the script points `latest` at it too (`npm dist-tag add … latest`, per
package). npm won't delete `latest`, so without this a plain `bun add
@bungohan/core` would keep installing whichever alpha got `latest` first,
and the npm page would show that alpha's README. `alpha` still moves as
before, and it's what the docs install. Once a stable version is published,
the script leaves `latest` on it and alphas move only `alpha`. Pass
`--no-latest` (`bun scripts/publish.ts --tag alpha --no-latest`) to skip the
step.

If the step fails partway, everything is already published; move the rest by
hand:

```sh
bunx npm dist-tag add @bungohan/<package>@<version> latest
```

Check one:

```sh
bunx npm view @bungohan/core@0.1.0-alpha.2
bunx npm view @bungohan/core dist-tags   # alpha and latest both on it
```

### 6. Tag the release commit

Tag the bump commit from step 2, never an earlier one: a tag on a commit
whose manifests still hold the previous version doesn't match what was
published.

```sh
git tag -a v0.1.0-alpha.2 -m "v0.1.0-alpha.2"
git push origin main --tags
```

If a tag was created too early and hasn't been pushed, delete it with
`git tag -d v0.1.0-alpha.2` and create it again on the bump commit.
