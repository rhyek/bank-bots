import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { AgentModels, sonnetModel } from '~/agent/agent-models.service';

const row = (value: string, resolvedModel?: string): ModelInfo => ({
  value,
  resolvedModel,
  displayName: value,
  description: '',
});

const saved = { ...process.env };

// Every test here stays on the paths that start no SDK session: a pinned model, or no token.
beforeEach(() => {
  for (const name of [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'TX_AI_MODEL',
    'TX_AI_EFFORT',
    'TX_LOCATION_MODEL',
    'TX_LOCATION_EFFORT',
  ]) {
    delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...saved };
});

async function booted(): Promise<AgentModels> {
  const models = new AgentModels(new StructuredLoggerService());
  await models.onModuleInit();
  return models;
}

test('sonnetModel: the id the sonnet alias resolves to', () => {
  const models = [
    row('default', 'claude-opus-5-5'),
    row('sonnet', 'claude-sonnet-5-5'),
    row('opus', 'claude-opus-5-5'),
  ];
  assert.equal(sonnetModel(models), 'claude-sonnet-5-5');
});

test('sonnetModel: undefined when the list has no sonnet alias', () => {
  // What a session without a token lists: full ids, no aliases.
  assert.equal(sonnetModel([row('claude-sonnet-5', 'claude-sonnet-5')]), undefined);
});

test('sonnetModel: undefined when the alias row does not say what it resolves to', () => {
  assert.equal(sonnetModel([row('sonnet')]), undefined);
});

test('without a token nothing is looked up and the alias itself is used', async () => {
  const models = await booted();
  assert.deepEqual(models.payeeMatcher(), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(models.location(), { model: 'sonnet', effort: 'medium' });
});

test('TX_AI_MODEL pins every agent, and nothing is looked up', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
  process.env.TX_AI_MODEL = 'claude-pinned';
  const models = await booted();
  assert.equal(models.payeeMatcher().model, 'claude-pinned');
  assert.equal(models.location().model, 'claude-pinned');
});

test('TX_LOCATION_MODEL pins the location agents only', async () => {
  process.env.TX_LOCATION_MODEL = 'claude-location';
  const models = await booted();
  assert.equal(models.payeeMatcher().model, 'sonnet');
  assert.equal(models.location().model, 'claude-location');
});

test('each effort has its own override', async () => {
  process.env.TX_AI_EFFORT = 'max';
  process.env.TX_LOCATION_EFFORT = 'low';
  const models = await booted();
  assert.equal(models.payeeMatcher().effort, 'max');
  assert.equal(models.location().effort, 'low');
});

test('reading the model before boot throws rather than running on an undefined one', () => {
  const models = new AgentModels(new StructuredLoggerService());
  assert.throws(() => models.payeeMatcher(), /before AgentModels\.onModuleInit finished/);
});
