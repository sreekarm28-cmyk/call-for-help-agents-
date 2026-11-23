import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { config } from "dotenv";
import { TemporaryGoogleError } from "../providers/google-request.js";

config({ quiet: true });

const toolName = "find_nearby_providers";
export async function callProviderSearch(args?: Record<string, unknown>) {
  const client = new Client({ name: "google-places-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("./google-places-server.ts", import.meta.url))],
    env: {
      GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY ?? "",
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
    },
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === toolName)) {
      throw new Error(`MCP server did not expose ${toolName}.`);
    }
    if (!args) {
      console.log(`Discovered MCP tool: ${toolName}`);
      return;
    }

    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });
    if (result.isError) {
      const details = result.structuredContent;
      if (typeof details === 'object' && details !== null && 'retryable' in details && details.retryable === true) {
        throw new TemporaryGoogleError('Google Places is temporarily unavailable.');
      }
      throw new Error(JSON.stringify(result.content));
    }
    return result.structuredContent ?? result.content;
  } finally {
    await client.close();
  }
}

function runDemoSearch(live: boolean) {
  return callProviderSearch(live ? {
    serviceType: "electrician",
    latitude: 12.9716,
    longitude: 77.5946,
    radiusMeters: 5_000,
    maxResults: 3,
  } : undefined);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await runDemoSearch(process.argv.includes("--live"));
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
