import { Component } from 'obsidian';
import type { LlmHubPlugin } from '../plugin';
declare class SafeGuardRuntime extends Component {
  constructor(host: LlmHubPlugin);
  ready: Promise<void>;
  settings: Record<string, unknown>;
  getLlmHubPlugin(): LlmHubPlugin;
}
export default SafeGuardRuntime;
