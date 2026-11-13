# Install or roll back the Windows x64 beta

[简体中文](INSTALL.zh-CN.md) · English

Use the full `llmhubpp-<version>-windows-x64.zip`. It includes the offline Wiki, Inbox presets, and Windows terminal files. Use Obsidian desktop. The manifest requires 1.13.0 or later, and the repair candidate was exercised with Obsidian 1.15.0 on Windows x64.

## First install

1. Start with an empty or disposable vault. Download the ZIP and `SHA256SUMS.txt` from the same beta under [GitHub Releases](https://github.com/Preston-se/llmhubpp/releases).
2. Compare the SHA-256 of your download against that file. In PowerShell, use `Get-FileHash -Algorithm SHA256 -LiteralPath <your ZIP>`.
3. Extract the archive and copy its `llmhubpp` folder into the vault's active configuration folder under `plugins`. The default destination is `.obsidian/plugins/llmhubpp`. Open `manifest.json` in that folder and check that the plugin ID is `llmhubpp`.
4. In **Settings → Community plugins**, enable **Llmhub++**. Open its settings and launch **Wiki**. Confirm it opens before setting up a model.
5. Add and verify one local or API text model. Try a short question. To test citations, configure a test index, add a sample note, and ask a question whose answer is in that note. Click the citation number to open the excerpt. [First setup](../resources/help/first-setup.md)

## Upgrade an existing vault

Make a backup of the vault or take copies of the existing plugin folder and its workspace folders, including the settings, history, indexes, Inbox scripts and your edits to presets. Take them at the same time. Keep the backup outside the vault and test restoration in a separate vault. Device secrets may need to be entered again on a different device.

Disable the plugin before replacing its program files. Copy the new release files into the existing plugin folder so local settings files stay in place. When moving from the separate legacy LLM Hub, Local LLM Hub, or Safe Guard plugins, disable those plugins in this vault before enabling Llmhub++. Keep their old folders with the backup.

After enabling the new build, open the Wiki, verify the selected model, and search a note that was already indexed. Check a custom preset or workflow you use. Change an index's model or rebuild it only when you need to change the index itself.

## Roll back

1. Save any new or edited notes somewhere safe before restoring a backup. Disable Llmhub++.
2. Restore the plugin files and the matching configuration and index folders from the same backup. Restore your newer notes separately. For a rollback to the legacy plugin, enable the matching legacy build once its settings and index are restored.
3. Verify that an existing note and index entry are readable before re-enabling automatic indexing. Older builds follow their own indexing rules and may not read index segments created by newer versions.

For source builds and the checks that produce the full ZIP, see [Development and tests](../CONTRIBUTING.md).
