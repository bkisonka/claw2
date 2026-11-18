import { describe, it, expect } from "vitest";
import { buildRunAgentTool, RUN_AGENT_TOOL } from "./llm.js";

describe("buildRunAgentTool", () => {
  it("uses free string when catalog empty", () => {
    const tool = buildRunAgentTool([]);
    const script = (tool.function as { parameters: { properties: { script: { enum?: string[] } } } })
      .parameters.properties.script;
    expect(script.enum).toBeUndefined();
    expect(RUN_AGENT_TOOL.function.name).toBe("run_agent");
  });

  it("puts enabled skills into script enum and description", () => {
    const tool = buildRunAgentTool([
      { name: "time.js", description: "Current time" },
      { name: "ya-search.js", description: "Yandex search" },
    ]);
    const params = tool.function.parameters as {
      properties: { script: { enum?: string[]; description: string } };
    };
    expect(params.properties.script.enum).toEqual(["time.js", "ya-search.js"]);
    expect(params.properties.script.description).toContain("time.js: Current time");
    expect(params.properties.script.description).toContain("ya-search.js: Yandex search");
  });
});
