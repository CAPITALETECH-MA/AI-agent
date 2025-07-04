import { createAzure } from '@ai-sdk/azure';
import { Agent } from '@mastra/core/agent';
import { sendEmailTool } from '../tools/gmail-api-tool';

const azure = createAzure({
  resourceName: 'talentino-openai-fra', 
  apiKey: process.env.AZURE_OPENAI_KEY, 
});

const azureModel = azure('gpt-4o');

export const myAzureAgent = new Agent({
  name: 'My Test Agent',
  instructions: 'You are a helpful assistant powered by Azure OpenAI GPT-4o. You can send emails using the send-email tool.',
  model: azureModel,
  tools: { sendEmail: sendEmailTool },
});
