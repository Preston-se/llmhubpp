import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = "node_modules/obsidian-llm-hub-common/dist/settings/";
const host = "src/ui/settings/";
// Each root is the renderer actually used by SettingsTab. Follow its settings
// helpers and modal classes, so newly added controls enter search automatically.
const roots = {
  menus:[[host+'readingMenuSettings.ts','displayReadingMenuSettings']],
  hotkeys:[[host+'hotkeySettings.ts','displayHotkeySettings']],
  assistant:[[host+'agentConfigurationSettings.ts','displayAgentConfigurationSettings']],
  transfer:[['src/ui/SettingsTab.tsx','property:transfer'],[host+'ConfigurationTransferModal.ts','ConfigurationTransferModal']],
  precision:[['src/ui/SettingsTab.tsx','property:precision'],[host+'ConfigurationEditorModal.ts','ConfigurationEditorModal']],
  help:[['src/ui/SettingsTab.tsx','property:help']],
  api: [[host + "apiProviderSettings.ts", "displayApiProviderSettings"]],
  local: [[host + "localLlmSettings.ts", "displayLocalLlmSettings"]],
  cli: [[host + "cliSettings.ts", "displayCliSettings"]],
  proxy: [[host + "proxySettings.ts", "displayProxySettings"]],
  source: [[host + "sourceIngestSettings.ts", "displaySourceIngestSettings"]],
  rag: [[host + "ragSettings.ts", "displayRagSettings"]],
  requests: [[host + "requestControlsSettings.ts", "displayRequestControls"]],
  jev: [[host + "jevSettings.ts", "displayJevSettings"]],
  okf: [[host + "knowledgeSettings.ts", "displayKnowledgeSettings"]],
  chat: [[shared + "voiceChatSettings.js", "addVoiceSubmitSettings"]],
  history: [[host + "workspaceSettings.ts", "displayChatBehaviorSettings"]],
  workspace: [[host + "workspaceSettings.ts", "displayToolPermissionSettings"]],
  storage: [[host + "storageSettings.ts", "displayStorageSettings"]],
  credentials: [[host + "credentialStorageSettings.ts", "displayCredentialStorageSettings"]],
  workflow: [["src/ui/SettingsTab.tsx", "property:workflow"]],
  slash: [[host + "slashCommandSettings.ts", "displaySlashCommandSettings"]],
  externalSkills: [[host + "externalSkillSettings.ts", "displayExternalSkillSettings"]],
  mcp: [[host + "mcpServersSettings.ts", "displayMcpServersSettings"]],
  agent: [[host + "agentPluginSettings.ts", "displayAgentPluginSettings"]],
  safeGuard: [["src/ui/SettingsTab.tsx", "property:safeGuard"], ["src/safeguard/runtime.js", "SafeGuardSettingTab"]],
  edits: [[host + "editHistorySettings.ts", "displayEditHistorySettings"]],
  encryption: [[host + "encryptionSettings.ts", "displayEncryptionSettings"]],
  langfuse: [[host + "langfuseSettings.ts", "displayLangfuseSettings"]],
};
const sources = new Map();
function source(file) {
  if (!sources.has(file)) sources.set(file, ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
  return sources.get(file);
}
function declaration(file, name, seen = new Set()) {
  const token = `${file}:${name}`;
  if (seen.has(token)) return null;
  seen.add(token);
  const ast = source(file);
  let found = null;
  function visit(node) {
    if (name.startsWith("property:") ? ts.isPropertyAssignment(node) && node.name.getText(ast) === name.slice(9)
      : (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) found ??= node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast);
  if (found) return { file, node: found };
  for (const statement of ast.statements) if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
    const target = resolve(file, statement.moduleSpecifier.text);
    if (target) { const exported = declaration(target, name, seen); if (exported) return exported; }
  }
  return null;
}
function resolve(file, specifier) {
  const base = specifier === "obsidian-llm-hub-common/settings" ? path.join(root, shared, "index.js")
    : specifier.startsWith("src/") ? path.join(root, specifier)
    : specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : null;
  if (!base) return null;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}
function allowed(file) { return file.includes(path.normalize("src/ui/settings/")) || file.includes(path.normalize(shared)); }
function imports(file) {
  const result = new Map();
  for (const statement of source(file).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    const target = resolve(file, statement.moduleSpecifier.text);
    if (!target || !allowed(target) || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const item of bindings.elements) result.set(item.name.text, { file: target, name: item.propertyName?.text ?? item.name.text });
  }
  return result;
}
function catalogue(file, name) {
  const found = declaration(path.join(root, file), name);
  let object = found?.node.initializer;
  while (object && (ts.isAsExpression(object) || ts.isSatisfiesExpression(object))) object = object.expression;
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`Catalogue is not a static object: ${file}`);
  return Object.fromEntries(object.properties.filter(property => ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer))
    .map(property => [ts.isStringLiteralLike(property.name) ? property.name.text : property.name.getText(), property.initializer.text]));
}
export function buildSearchCatalog() {
  const common = "node_modules/obsidian-llm-hub-common/dist/i18n/catalogues/";
  const en = { ...catalogue(common + "en.js", "en"), ...catalogue("src/i18n/en.ts", "en") };
  const zh = { ...catalogue(common + "zh.js", "zh"), ...catalogue("src/i18n/zh.ts", "zh"), ...catalogue("src/i18n/settingsZh.ts", "settingsZh") };
  return Object.fromEntries(Object.entries(roots).map(([section, entries]) => {
    const keys = new Set(), aliases = new Set(), visited = new Set();
    function collect(file, node) {
      const token = `${file}:${node.pos}:${node.end}`;
      if (visited.has(token)) return;
      visited.add(token);
      const imported = imports(file);
      function visit(child) {
        if (ts.isStringLiteralLike(child)) {
          const value = child.text;
          if (en[value] || zh[value]) { keys.add(value); if (en[value]) aliases.add(en[value]); if (zh[value]) aliases.add(zh[value]); }
          else {
            const parent = child.parent;
            const isLabel = ts.isCallExpression(parent) && (ts.isIdentifier(parent.expression) && parent.expression.text === "tr"
              || ts.isPropertyAccessExpression(parent.expression) && ["setName", "setDesc", "setTooltip", "setButtonText"].includes(parent.expression.name.text));
            if (value.length > 1 && value.length < 200 && (isLabel || /\s|[\u4e00-\u9fff]/.test(value))
              && !/(?:^|[ .])llm[-_]/.test(value)) aliases.add(value);
          }
        }
        if (ts.isIdentifier(child)) {
          const entry = imported.get(child.text);
          const linked = entry ? declaration(entry.file, entry.name) : declaration(file, child.text);
          if (linked && linked.node !== child && (allowed(linked.file) || linked.file === file)) collect(linked.file, linked.node);
        }
        ts.forEachChild(child, visit);
      }
      visit(node);
    }
    for (const [file, name] of entries) {
      const found = declaration(path.join(root, file), name);
      if (!found) throw new Error(`Missing settings renderer: ${file}:${name}`);
      collect(found.file, found.node);
    }
    return [section, { keys: [...keys].sort(), aliases: [...aliases].sort() }];
  }));
}
export function renderSearchCatalog() {
  return "// Generated from the actual host/shared settings renderers and modals.\n// Run node scripts/generate-settings-search.mjs after changing controls.\n"
    + "export const SETTINGS_SEARCH_CATALOG: Record<string, { keys: readonly string[]; aliases: readonly string[] }> = " + JSON.stringify(buildSearchCatalog(), null, 2) + ";\n";
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.join(root, "src/ui/settings/settingsSearchCatalog.ts");
  const output = renderSearchCatalog();
  if (process.argv.includes("--check")) { if (fs.readFileSync(target, "utf8") !== output) throw new Error("Settings search catalogue is stale; regenerate it."); }
  else fs.writeFileSync(target, output);
}
