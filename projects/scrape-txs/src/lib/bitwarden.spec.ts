import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBankCredentials } from './bitwarden';

const item = {
  name: 'some bank',
  login: { username: 'user1', password: 'pw1' },
  fields: [{ name: 'campoInstalacion', value: '12345' }],
};

test('parseBankCredentials: username + password from the login', () => {
  assert.deepEqual(parseBankCredentials(item), { username: 'user1', password: 'pw1' });
});

test('parseBankCredentials: reads the code from the named custom field', () => {
  assert.deepEqual(parseBankCredentials(item, { codeField: 'campoInstalacion' }), {
    username: 'user1',
    password: 'pw1',
    code: '12345',
  });
});

test('parseBankCredentials: a custom field never overrides the login password', () => {
  const withExtra = { ...item, fields: [{ name: 'Contraseña', value: 'other' }] };
  assert.equal(parseBankCredentials(withExtra).password, 'pw1');
});

test('parseBankCredentials: missing password names the item, not a value', () => {
  const noPassword = { ...item, login: { username: 'user1', password: null } };
  assert.throws(
    () => parseBankCredentials(noPassword),
    /Bitwarden item "some bank" has no password/,
  );
});

test('parseBankCredentials: missing code field is an error', () => {
  const noFields = { name: 'some bank', login: item.login };
  assert.throws(
    () => parseBankCredentials(noFields, { codeField: 'campoInstalacion' }),
    /Bitwarden item "some bank" has no "campoInstalacion" field/,
  );
});
