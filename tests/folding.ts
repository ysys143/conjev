// Folding is off by default. The suites that test the fold load the plugin with
// it on unless a test says otherwise, so each of them reads as it did.
import type { TestOptions, TestRest } from 'claude-code/testing'
import { test as base } from 'claude-code/testing'

const withFold = (options: TestOptions = {}): TestOptions => ({ ...options, options: { fold: 'on', ...options.options } })

export const test = (name: string, ...rest: TestRest): void =>
  rest.length === 1 ? base(name, withFold(), rest[0]) : base(name, withFold(rest[0]), rest[1])
