import { describe, expect, test } from "bun:test";

import { catalogRefreshTasks } from "./catalogRefresh";

describe("catalogRefreshTasks", () => {
  test("a config rebuild re-reads every list a config file can carry", () => {
    // Agents, commands, skills, MCP servers, providers and the web search
    // choice still have Settings consumers.
    expect(catalogRefreshTasks("config")).toHaveLength(6);
  });

  test("a single-catalog rebuild re-reads only that list", () => {
    for (const kind of ["agent", "command", "skill", "provider", "websearch"] as const) {
      expect(catalogRefreshTasks(kind)).toHaveLength(1);
    }
  });

  test("a credential change re-reads providers and web search keys", () => {
    expect(catalogRefreshTasks("credential")).toHaveLength(2);
  });

  test("projects and plugins have no Settings catalog consumer", () => {
    expect(catalogRefreshTasks("plugin")).toEqual([]);
    expect(catalogRefreshTasks("project")).toEqual([]);
  });
});
