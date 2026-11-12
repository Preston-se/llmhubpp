import { describe, expect, it, vi } from "vitest";
import type { LocalRagSearchResult } from "./localRagStore";
import {
  MAX_DYNAMIC_RAG_RESULTS,
  MAX_RAG_SEARCHES_PER_TURN,
  RAG_SEARCH_TOOL,
  createRagSearchRunner,
} from "./ragSearchTool";

const chunk = (filePath: string, text = "body"): LocalRagSearchResult => ({
  filePath, text, score: 0.8, chunkIndex: 0,
});

interface ToolResult {
  query?: string;
  results?: { filePath: string; text: string; score: number }[];
  remainingSearches?: number;
  error?: string;
}

describe("rag_search tool", () => {
  it('preserves document and chunk provenance in results and saved evidence', async () => {
    const provenance={documentId:'stable',chunkId:'chunk',documentOffset:300,heading:'中段',indexSetting:'S'};
    const runner=createRagSearchRunner(async()=>[{...chunk('a.md'),...provenance}],undefined,{settingName:'Combined'});
    const result=await runner.run({query:'q'}) as any;
    expect(result.results[0]).toMatchObject(provenance);
    expect(runner.getEvidence()?.sources[0]).toMatchObject(provenance);
  });
  it("keeps stable citation ids across tool searches and snapshots only this turn", async () => {
    let count = 0;
    const runner = createRagSearchRunner(async () => ++count === 1 ? [chunk('a.md', 'First')] : [chunk('a.md', 'First'), chunk('b.md', 'Second')],
      undefined, { topK: 6, settingName: 'Study', query: 'question' });
    const first = await runner.run({ query: 'one' }) as ToolResult;
    const second = await runner.run({ query: 'two' }) as ToolResult;
    expect(first.results?.[0]).toMatchObject({ id: 1 });
    expect(second.results).toMatchObject([{ id: 1 }, { id: 2 }]);
    expect(runner.getEvidence()?.sources.map(s => s.text)).toEqual(['First', 'Second']);
    expect(createRagSearchRunner(async () => [], undefined, { settingName: 'Next' }).getEvidence()).toBeNull();
  });
  it("requires a focused query", () => {
    expect(RAG_SEARCH_TOOL.name).toBe("rag_search");
    expect(RAG_SEARCH_TOOL.parameters.required).toEqual(["query"]);
  });

  it("returns chunks and the remaining budget", async () => {
    const runner = createRagSearchRunner(async () => [chunk("spec/product.md", "Product details")]);
    const result = await runner.run({ query: "  product overview  " }) as ToolResult;

    expect(result.query).toBe("product overview");
    expect(result.results).toEqual([
      { filePath: "spec/product.md", score: 0.8, text: "Product details" },
    ]);
    expect(result.remainingSearches).toBe(MAX_RAG_SEARCHES_PER_TURN - 1);
  });

  it("caps how many chunks a follow-up search may pull", async () => {
    const search = vi.fn(async () => [chunk("a.md")]);
    await createRagSearchRunner(search).run({ query: "q" });
    expect(search).toHaveBeenCalledWith("q", MAX_DYNAMIC_RAG_RESULTS);
  });

  it.each([6, 2])("uses the configured Top K of %i and never returns more", async (topK) => {
    const search = vi.fn(async () => Array.from({ length: 6 }, (_, i) => chunk(`${i}.md`)));
    const runner = createRagSearchRunner(search, undefined, { topK });
    const response = await runner.run({ query: "term" }) as ToolResult;
    expect(search).toHaveBeenCalledWith("term", topK);
    expect(response.results).toHaveLength(topK);
    expect(runner.systemPrompt).toContain(`at most ${topK} chunks`);
  });

  it("allows three on-demand searches per turn", async () => {
    const search = vi.fn(async () => [chunk("a.md")]);
    const runner = createRagSearchRunner(search);
    for (let i = 0; i < MAX_RAG_SEARCHES_PER_TURN; i++) {
      expect((await runner.run({ query: `q${i}` }) as ToolResult).error).toBeUndefined();
    }
    const exhausted = await runner.run({ query: "one too many" }) as ToolResult;

    expect(exhausted.error).toMatch(/limit reached/);
    expect(search).toHaveBeenCalledTimes(MAX_RAG_SEARCHES_PER_TURN);
  });

  it("does not charge a failed search against the budget", async () => {
    const search = vi.fn()
      .mockRejectedValueOnce(new Error("embedding timeout"))
      .mockResolvedValue([chunk("a.md")]);
    const runner = createRagSearchRunner(search);

    const failed = await runner.run({ query: "q" }) as ToolResult;
    expect(failed.error).toMatch(/RAG search failed/);

    const after = await runner.run({ query: "q" }) as ToolResult;
    expect(after.remainingSearches).toBe(MAX_RAG_SEARCHES_PER_TURN - 1);
  });

  it("does not return credentials or private URLs in a tool failure", async () => {
    const runner = createRagSearchRunner(async () => { throw new Error("https://private.example/?api_key=SECRET_VALUE"); });
    const failed = await runner.run({ query: "q" }) as ToolResult;
    expect(failed.error).toMatch(/RAG search failed/);
    expect(failed.error).not.toContain("SECRET_VALUE");
    expect(failed.error).not.toContain("private.example");
  });

  it("rejects a missing or blank query without spending the budget", async () => {
    const search = vi.fn(async () => [chunk("a.md")]);
    const runner = createRagSearchRunner(search);

    expect((await runner.run({}) as ToolResult).error).toBeTruthy();
    expect((await runner.run({ query: "   " }) as ToolResult).error).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });

  it("reports each newly retrieved file once", async () => {
    const onSources = vi.fn();
    const runner = createRagSearchRunner(
      async () => [chunk("a.md"), chunk("a.md"), chunk("b.md")],
      onSources,
    );

    await runner.run({ query: "q" });

    expect(onSources).toHaveBeenCalledWith(["a.md", "b.md"]);
  });

  it("does not report sources when a search finds nothing", async () => {
    const onSources = vi.fn();
    await createRagSearchRunner(async () => [], onSources).run({ query: "q" });
    expect(onSources).not.toHaveBeenCalled();
  });
});
