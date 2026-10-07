import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MARKER, stickyComment } from '../lib/github.mjs'

// A fake `gh` on PATH: logs each call, lists the given comment ids for the comments API.
function fakeGh(ids) {
  const dir = mkdtempSync(join(tmpdir(), 'focus-gh-'))
  const log = join(dir, 'calls.log')
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\nprintf '%s@@' "$*" >> '${log}'\ncase "$*" in "api repos/o/r/issues/5/comments"*) printf '${ids.join('\\n')}' ;; esac\nexit 0\n`)
  chmodSync(join(dir, 'gh'), 0o755)
  const old = process.env.PATH
  process.env.PATH = `${dir}:${old}`
  return { calls: () => readFileSync(log, 'utf8').split('@@').filter(Boolean), restore: () => (process.env.PATH = old) }
}

test('a review round edits the sticky Focus Hour comment instead of posting a new one', () => {
  const gh = fakeGh(['111', '222'])
  try {
    assert.equal(stickyComment({ root: tmpdir() }, 5, 'review', 'round 2', 'o/r'), true)
    const calls = gh.calls()
    assert.ok(calls.some(c => c.startsWith('api --method PATCH repos/o/r/issues/comments/222 -f body=round 2') && c.includes(MARKER)))
    assert.ok(!calls.some(c => c.startsWith('pr comment')))
  } finally {
    gh.restore()
  }
})

test('the first round posts the sticky comment', () => {
  const gh = fakeGh([])
  try {
    stickyComment({ root: tmpdir() }, 5, 'review', 'round 1', 'o/r')
    assert.ok(gh.calls().some(c => c.startsWith('pr comment 5 --body round 1') && c.includes('<!-- focus-hour:review -->')))
  } finally {
    gh.restore()
  }
})
