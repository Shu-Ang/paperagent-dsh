import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { downloadPublicPdf, isPublicInternetAddress } from '../packages/tools/src/import/binary-downloader.ts'

test('public PDF downloader rejects non-HTTPS and private-network targets before writing staging files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'paperagent-download-'))
  try {
    await assert.rejects(
      downloadPublicPdf({ workspacePath: workspace, url: 'http://example.com/paper.pdf', maxBytes: 1024 }),
      /only HTTPS PDF URLs/i,
    )
    await assert.rejects(
      downloadPublicPdf({ workspacePath: workspace, url: 'https://127.0.0.1/paper.pdf', maxBytes: 1024 }),
      /public internet addresses/i,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('public-address policy rejects private, documentation, multicast, and mapped IPv6 ranges', () => {
  for (const address of ['10.0.0.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:10.0.0.1']) {
    assert.equal(isPublicInternetAddress(address), false, address)
  }
  assert.equal(isPublicInternetAddress('8.8.8.8'), true)
  assert.equal(isPublicInternetAddress('2606:4700:4700::1111'), true)
})
