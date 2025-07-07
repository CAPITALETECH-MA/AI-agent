import { createAzure } from '@ai-sdk/azure';
import { Agent } from '@mastra/core';

const azure = createAzure({
  resourceName: 'talentino-openai-fra',
  apiKey: process.env.AZURE_OPENAI_KEY,
});

const azureModel = azure('gpt-4o');

export function createMyAzureAgent(tools: Record<string, any>) {
  return new Agent({
    name: 'My Test Agent',
          instructions:
        'You are a Missing Information Detection Agent. Use the detect-missing-info tool to automatically extract contacts with missing information and identify what specific information is missing. You can also send follow-up emails when needed.',
    model: azureModel,
    tools,
  });
}