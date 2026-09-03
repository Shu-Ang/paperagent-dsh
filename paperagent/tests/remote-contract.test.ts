import assert from 'node:assert/strict'
import test from 'node:test'
import { paperAgentRemoteContract } from '../packages/contracts/src/index.ts'
import { paperAgentRemote } from '../packages/ui/src/client/remote.ts'

test('PaperAgent browser descriptors exactly follow the shared Remote contract', () => {
  const expected = paperAgentRemoteContract.map(item => ({ method: item.method, parameters: [...item.parameters] }))
  const actual = paperAgentRemote.descriptors.map(item => ({
    method: item.method,
    parameters: item.parameters.map(parameter => parameter.name),
  }))
  assert.deepEqual(actual, expected)
})

test('PaperAgent contract has unique methods and always begins with the owning session', () => {
  const methods = paperAgentRemoteContract.map(item => item.method)
  assert.equal(new Set(methods).size, methods.length)
  for (const item of paperAgentRemoteContract) {
    assert.equal(item.parameters[0], 'sessionId', `${item.method} must be scoped by sessionId`)
  }
})
