// Instruction files shaped like the real ones, for the filter's tests.

export const AGENTS = `# AGENTS.md — rules

Read by every agent.

## 사용자 정체성

The person is not Andy. Refer to them neutrally.

## 언어

Always answer in Korean unless asked otherwise, in every report.

## 도구 우선순위

### 브라우저 자동화

Use ego-browser first; never load claude-in-chrome.

### 웹 페이지 가져오기

Fetch a page through Jina Reader first: https://r.jina.ai/<URL>, then the built-in tool.

### Orca 오케스트레이션

When the session runs in Orca, ask before splitting work across workers.

## LLM 호출 경로

Call LLMs through subscription runtimes such as claude -p, never API keys by default.
`

export const omc = (extra = ''): string => `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

You are running with OMC.

<operating_principles>
- Delegate specialized work.
- Prefer evidence over assumptions.${extra}
</operating_principles>

<verification>
Verify before claiming completion, every time.
</verification>

## Setup

Say "setup omc" to install it.
`
