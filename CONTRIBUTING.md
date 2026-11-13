# Build and test Llmhub++

The desktop plugin entry is `src/main-unified.ts`. TypeScript and React code is under `src/`. The offline Wiki and release assets are under `resources/`. Packaging and documentation checks are under `scripts/`.

Use the Node.js version in [.node-version](.node-version) and run these commands from the repository root.

```text
npm ci --ignore-scripts
npm run lint -- --max-warnings 0
npm test -- --maxWorkers=1
npm run build
npm run test:package
```

The Windows regression suite uses OpenSSL. Git for Windows includes it in `usr/bin`. Put that directory on the test process's `PATH` if OpenSSL is missing. The build runs the Wiki and configuration MCP contract checks and creates the core plugin files. Run `npm run package:llmhubpp` to build and package the Windows x64 ZIP and checksum.

Reproduce user flows in a separate Obsidian vault with synthetic notes and credentials. Cover the action through its normal entry point, then include the smallest test that reproduces the failure. When a visible setting or behavior changes, update its offline Wiki topic, feature map, and configuration MCP documentation as applicable. [Development checklist](docs/DEVELOPMENT_COMPLETION.md)

Keep vault data, credentials, indexes, personal environment settings, and local build evidence out of changes intended for publication. See [NOTICE.md](NOTICE.md) before modifying vendored assets or license files.

[Development workflow and naming](docs/DEVELOPMENT.md) · [Windows beta release process](docs/RELEASING.md)
