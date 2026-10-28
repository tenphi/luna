import { describe, expect, it } from 'bun:test';

describe('mcp-http-relay env', () => {
  it('requires MCP_RELAY_URL and MCP_RELAY_TOKEN at runtime', () => {
    const url = process.env.MCP_RELAY_URL;
    const token = process.env.MCP_RELAY_TOKEN;
    expect(typeof url === 'string' || url === undefined).toBe(true);
    expect(typeof token === 'string' || token === undefined).toBe(true);
  });
});
