# @sourcegraph/lsp-client

[![npm](https://img.shields.io/npm/v/@sourcegraph/lsp-client.svg)](https://www.npmjs.com/package/@sourcegraph/lsp-client)
[![downloads](https://img.shields.io/npm/dt/@sourcegraph/lsp-client.svg)](https://www.npmjs.com/package/@sourcegraph/lsp-client)
[![build](https://travis-ci.org/sourcegraph/lsp-client.svg?branch=master)](https://travis-ci.org/sourcegraph/lsp-client)
[![codecov](https://codecov.io/gh/sourcegraph/lsp-client/branch/master/graph/badge.svg?token=Wwxuf9Th3k)](https://codecov.io/gh/sourcegraph/lsp-client)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

Library that connects Sourcegraph extensions to language servers

## Install

```
npm install @sourcegraph/lsp-client
# or
yarn add @sourcegraph/lsp-client
```

## Build

```
yarn
yarn build
```

## Test

```
yarn test
```

## Release

Releases are done automatically in CI when commits are merged into master by analyzing [Conventional Commit Messages](https://conventionalcommits.org/).
After running `yarn`, commit messages will be linted automatically when committing though a git hook.
The git hook can be circumvented for fixup commits with [git's `fixup!` autosquash feature](https://fle.github.io/git-tip-keep-your-branch-clean-with-fixup-and-autosquash.html), or by passing `--no-verify` to `git commit`.
You may have to rebase a branch before merging to ensure it has a proper commit history, or squash merge with a manually edited commit message that conforms to the convention.
