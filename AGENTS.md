# Development notes

Use the Node.js version in `.node-version` and install from the lockfile. [Build and test](CONTRIBUTING.md)

Keep user-visible settings in sync in Chinese and English. Update the offline Wiki, feature map and configuration MCP when their documented behavior changes. [Development completion](docs/DEVELOPMENT_COMPLETION.md)

Use a disposable Obsidian vault for integration tests. Keep personal vaults, credentials, indexes and machine-specific evidence out of commits. Preserve existing data and external identifiers during upgrades.

Push version commits on a branch. The manual GitHub Release workflow creates the release for the reviewed main commit.

One task, one branch. After the pull request merges, delete the branch; keep `main` as the only long-lived branch and note any exception with its cleanup condition. [Daily development](docs/DEVELOPMENT.md)
