import { TFile, TFolder, type EventRef, type Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { registerVaultIndexEvents } from "./registerVaultIndexEvents";

type Change = "create" | "modify" | "rename" | "delete";
type Callback = (file: TFile | TFolder, oldPath?: string) => void;

function vaultFixture() {
  const active = new Map<Change, Set<Callback>>();
  const vault = {
    on(kind: Change, callback: Callback) {
      if (!active.has(kind)) active.set(kind, new Set());
      active.get(kind)!.add(callback);
      return { kind, callback };
    },
  };
  function owner() {
    const refs: ReturnType<typeof vault.on>[] = [];
    const cleanup: (() => void)[] = [];
    const plugin = {
      app: { vault },
      registerEvent: (ref: EventRef) => { refs.push(ref as unknown as typeof refs[number]); },
      register: (dispose: () => void) => { cleanup.push(dispose); },
    } as unknown as Pick<Plugin, "app" | "registerEvent" | "register">;
    const unload = () => {
      for (const ref of refs) active.get(ref.kind)?.delete(ref.callback);
      for (const dispose of cleanup) dispose();
    };
    return { plugin, unload };
  }
  const emit = (kind: Change, file: TFile | TFolder, oldPath?: string) => {
    for (const callback of active.get(kind) ?? []) callback(file, oldPath);
  };
  return { owner, emit };
}

const file = (path: string) => Object.assign(new TFile(), { path });
const folder = (path: string, ...children: (TFile | TFolder)[]) => Object.assign(new TFolder(), { path, children });

describe("Vault events for the index", () => {
  const readyLifecycle = { initialize: async () => {}, dispose: () => {} };

  it("uses descendant paths for folder moves and filters changes entirely inside managed storage", async () => {
    const vault = vaultFixture();
    const change = vi.fn(async () => {});
    await registerVaultIndexEvents(vault.owner().plugin, {
      ...readyLifecycle,
      managedDirectories: () => ["Managed"],
      changed: change,
      onError: vi.fn(),
    });

    vault.emit("modify", file("Managed/cache.md"));
    vault.emit("rename", folder("Managed/new", file("Managed/new/a.md")), "Managed/old");
    vault.emit("rename", folder("Managed/in", folder("Managed/in/sub", file("Managed/in/sub/a.md"))), "Notes/old");
    vault.emit("rename", folder("Notes/out", file("Notes/out/b.md")), "Managed/out");

    expect(change.mock.calls).toEqual([
      ["rename", "Managed/in/sub/a.md", "Notes/old/sub/a.md"],
      ["rename", "Notes/out/b.md", "Managed/out/b.md"],
    ]);
  });

  it("releases the old listeners before another plugin lifetime registers", async () => {
    const vault = vaultFixture();
    const old = vault.owner();
    const changed = vi.fn(async () => {});
    const onError = vi.fn();
    const callbacks = { ...readyLifecycle, managedDirectories: () => [], changed, onError };
    await registerVaultIndexEvents(old.plugin, callbacks);
    vault.emit("create", file("Notes/one.md"));
    old.unload();
    vault.emit("modify", file("Notes/one.md"));
    expect(changed).toHaveBeenCalledTimes(1);

    const replacement = vault.owner();
    await registerVaultIndexEvents(replacement.plugin, callbacks);
    const issue = new Error("synthetic index failure");
    changed.mockRejectedValueOnce(issue);
    vault.emit("delete", file("Notes/one.md"));
    await Promise.resolve();
    expect(changed.mock.calls).toEqual([["create", "Notes/one.md", undefined], ["delete", "Notes/one.md", undefined]]);
    expect(onError).toHaveBeenCalledWith(issue);
  });

  it("does not attach listeners if the plugin unloads while index recovery is pending", async () => {
    const vault = vaultFixture();
    const owner = vault.owner();
    let finishRecovery!: () => void;
    const recovery = new Promise<void>(resolve => { finishRecovery = resolve; });
    const changed = vi.fn(async () => {});
    const dispose = vi.fn();
    const starting = registerVaultIndexEvents(owner.plugin, {
      initialize: () => recovery,
      dispose,
      managedDirectories: () => [],
      changed,
      onError: vi.fn(),
    });
    vault.emit("create", file("Notes/before-recovery.md"));
    owner.unload();
    finishRecovery();
    await starting;
    vault.emit("modify", file("Notes/after-unload.md"));
    expect(dispose).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });
});
