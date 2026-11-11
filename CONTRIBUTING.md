# Contributing to Kantor Agent

Thank you for contributing to Kantor Agent. This project follows strict zero-dependency standards and test-driven development.

## Development Principles

1. Zero external npm dependencies: runtime and test suites use only Node.js built-ins (`node:test`, `node:assert`, `node:http`, etc.). Do not add `dependencies` or `devDependencies` to `package.json`.
2. Antislop copy hygiene: avoid em-dashes, decorative emojis, marketing fluff, or AI boilerplate. Keep documentation direct and factual.
3. Test-driven verification: all behavior changes, bug fixes, and features must include automated tests in `tests/`.

## Getting Started

Prerequisites:
- Node.js 22.5.0 or higher
- Git

Because this project has zero external npm dependencies, running `npm install` is neither needed nor supported.

Run the test suite directly:

```bash
npm test
```

Or run an individual test file:

```bash
node --test tests/setup-team.test.mjs
```

Validate the Antigravity plugin manifest:

```bash
agy plugin validate --strict .
```

## Pull Request Guidelines

1. Create a feature branch from `main` (for example, `feat/my-feature` or `fix/my-bug`).
2. Write tests before or alongside your implementation changes.
3. Ensure `npm test` passes cleanly across all test files.
4. Keep commits atomic and informative following Conventional Commits (for example, `feat: ...`, `fix: ...`, `test: ...`, `chore: ...`).
5. Open a pull request against `main` describing what changed and providing test verification evidence.
