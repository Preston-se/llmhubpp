import { Platform, type App } from 'obsidian';
export interface HotkeyBinding {
    modifiers: string[];
    key: string;
}
export interface HotkeyCommand {
    id: string;
    name: string;
    hotkeys?: HotkeyBinding[];
}
export interface HotkeySnapshot {
    commands: Record<string, HotkeyCommand>;
    bindings: Record<string, HotkeyBinding[]>;
    available: boolean;
    platform?: 'mac' | 'windows';
}
export function inspectHotkeyConflict(commandId: string, binding: HotkeyBinding, snapshot: HotkeySnapshot): {
    checked: boolean;
    conflicts: HotkeyCommand[];
} {
    const normalize = (b: HotkeyBinding) => `${[...new Set(b.modifiers.map(m => m === 'Mod' ? (snapshot.platform === 'mac' ? 'Meta' : 'Ctrl') : m))].sort().join('+')}+${b.key.toUpperCase()}`;
    return { checked: snapshot.available, conflicts: snapshot.available ? Object.values(snapshot.commands).filter(c => c.id !== commandId && (snapshot.bindings[c.id] ?? c.hotkeys ?? []).some(h => normalize(h) === normalize(binding))) : [] };
}
export function readEffectiveHotkeys(app: App): HotkeySnapshot {
    const host = app as unknown as {
        commands?: {
            commands: Record<string, HotkeyCommand>;
        };
        hotkeyManager?: {
            customKeys?: Record<string, HotkeyBinding[]>;
            getHotkeys?: (id: string) => HotkeyBinding[] | undefined;
            getDefaultHotkeys?: (id: string) => HotkeyBinding[] | undefined;
        };
    };
    const commands = host.commands?.commands ?? {}, manager = host.hotkeyManager, bindings: Record<string, HotkeyBinding[]> = {};
    for (const [id, command] of Object.entries(commands))
        bindings[id] = manager?.customKeys?.[id] ?? manager?.getHotkeys?.(id) ?? manager?.getDefaultHotkeys?.(id) ?? command.hotkeys ?? [];
    return { commands, bindings, available: !!manager && !!host.commands, platform: Platform.isMacOS ? 'mac' : 'windows' };
}
