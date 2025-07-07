import { Mastra } from '@mastra/core';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { MCPClient } from '@mastra/mcp';
import { createMyAzureAgent } from './agents/my-azure-agent';
import { getAllTools } from './tools/agent-tools';

// Configure your MCP client for PostgreSQL database access
export const mcpClient = new MCPClient({
  servers: {
    postgres: {
      command: 'npx',
      args: [
        '-y',
        '@modelcontextprotocol/server-postgres',
        'postgresql://neondb_owner:npg_y4mEQOAV2cBa@ep-tight-snow-a2tgx0zg-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require',
      ],
    },
  },
});

async function initializeMastra() {
  const allTools = await getAllTools();
  const myAzureAgent = createMyAzureAgent(allTools);

  return new Mastra({
    agents: { myAzureAgent },
    storage: new LibSQLStore({
      // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
      url: ':memory:',
    }),
    logger: new PinoLogger({
      name: 'Mastra',
      level: 'info',
    }),
  });
}

export const mastra = await initializeMastra();
