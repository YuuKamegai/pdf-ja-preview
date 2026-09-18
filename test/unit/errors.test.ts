import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelMissingError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../../src/translate/errors';
import {
  OllamaModelMissingError,
  OllamaUnavailableError,
} from '../../src/translate/ollama';

test('旧名は新しいクラスと同一である', () => {
  assert.equal(OllamaModelMissingError, ModelMissingError);
  assert.equal(OllamaUnavailableError, ProviderUnavailableError);
});

test('旧名で作った例外は新名でも instanceof が通る', () => {
  const error = new OllamaModelMissingError('test-model');
  assert.ok(error instanceof ModelMissingError);
  assert.equal(error.model, 'test-model');
  assert.equal(error.message, 'モデルが見つかりません: test-model');
});

test('例外はそれぞれ固有の name を持つ', () => {
  assert.equal(new ProviderUnavailableError('x').name, 'ProviderUnavailableError');
  assert.equal(new ModelMissingError('m').name, 'ModelMissingError');
  assert.equal(new ProviderAuthError('x').name, 'ProviderAuthError');
  assert.equal(new ProviderRateLimitError('x').name, 'ProviderRateLimitError');
  assert.equal(new ProviderConfigError('x').name, 'ProviderConfigError');
});

test('cause を引き継ぐ', () => {
  const cause = new Error('原因');
  assert.equal(new ProviderUnavailableError('x', { cause }).cause, cause);
});
