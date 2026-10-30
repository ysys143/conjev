# 평가 진행 기록

업데이트: 2026-10-27T19:24:18+09:00.

파일럿과 첫 본실험 비교쌍을 완료했다. 본실험은 2/36이며 Q1 1/9쌍·Q3 0/9쌍이다. 첫 본실험의 H·V는 모두 12/12단계·위반 검출 0건·재진술 6/7이다. [첫 본실험 결과](main-pair-1-results.md)에 실행·판정·원본 보존 근거가 있다. Q1·Q3 모두 유효한 비교쌍 1개씩 확보했다. 각 조건의 12단계 과제 검사와 제약·결정 검사에서 과제 미완료·위반은 0건이다. 재진술 28항목은 모두 판정됐으며 V 6/7, 나머지 조건 7/7이 통과했다. S1에서는 완료 보고를 막는 개입 1회가 관측됐다. 단일 파일럿이므로 일반적 성능 개선 결론은 없다.

| 단계 | 현재 결과 |
| --- | --- |
| 실행 환경 | 최종 소스 23/23 PASS |
| 장치 | 92개·각 3회 = 276개; 보존 255개 재검증·21개 신규 |
| 전송 부하 | 64/64, 연결 1개·재사용 63회 |
| 평가 도구 | 기본 95개·수정 검증 새 13개와 기존 8개·환경 감사 7개 통과 |
| 파일럿 실행 | V/H/S1/S0 모두 12/12, 요청 323건 완전 수집·exit 0 |
| 독립 최종 판정 | 과제 Stop 49건·재진술 28항목 모두 판정; 실패·보완 포함 82패킷 보존 |
| 최종 감사 | Q1 1/1, Q3 1/1; 데이터 누락 변이 5종 모두 거부 |
| 본실험 | Q1 2/18, Q3 0/18; 유효 Q1 비교쌍 1개 완료 |

[결과·비용·한계](pilot-results.md), [최종 감사](../../experiments/long-task/runs/pilot-20261027-2/acceptance-final.json), [수치 집계](../../experiments/long-task/runs/pilot-20261027-2/report-data.json)에 실제 입력·출력 대응을 남겼다. 원래 실패 시도·잘못된 판정·미판정 응답은 삭제하거나 성공으로 덮지 않았다. 사용자가 재시도 횟수를 제한했다는 앞선 설명은 잘못이었다.

### 이전 시도와 판정 기록

전체 성능 연구는 미완이다. Phase 0은 현재 소스 기준 23/23, Phase 1은 19개 영역·92개 케이스를 각 3회씩 확인한 276/276 관측으로 통과했다. 현재 평가 도구 테스트는 90개가 통과했다.

| 구분 | 현재 확인한 결과 | 근거 |
| --- | --- | --- |
| Phase 0 | 23/23 PASS | `runs/phase0-20261026-prepilot-2/acceptance.json`, 입력 묶음 `phase0-evidence-20261026-4.json` |
| Phase 1 | 276/276 PASS, 독립 Stop 문구 판정 36/36 | `/private/tmp/ch-research-phase1-20261026-19/acceptance.json`; [장치 검증 결과](phase-1-results.md) |
| 평가 도구 | 90개 테스트 PASS, 경고 0건 | 같은 경로의 `evaluator-tests.log` |
| 첫 파일럿 시도 | V가 12단계·목표 재진술을 수행했으나, 종료 후 평가기 오류로 제외 | `runs/pilot-20261026-1/failure-audit.json` |
| 정식 파일럿 | 네 조건 실행 종료. V·S1 캡처 실패, H 10단계·S0 9단계 입력 상한 결과. Q1·Q3 비교쌍은 모두 결측 | `/private/tmp/ch-research-pilot-20261026-2/pilot-spec.json`; V → H → S1 → S0 |
| 본실험 | Q1 0/18, Q3 0/18 | 현재 별도 지시는 선행 검증과 파일럿 4회까지이며, 본실험은 실행하지 않았다 |

위 `runs/`와 입력 묶음은 `experiments/long-task/` 아래에 있다. 현재 모델은 실행 Haiku/max, 판정 Opus/low이며 구독 경로를 사용한다. 초기 V의 후처리 오류는 CLI가 도구 입력을 이력에 표현하는 차이 48개를 충돌로 오인한 문제였다. 실제 종료 코드가 파일로 보존되지 않아 정식 비교에 포함하지 않는다. 계획에서 허용한 인프라 실패 대체 쌍 1회를 Q1에 사용하며, 초기 자료와 비용은 보존한다. 평가기 보완 후에는 Phase 0과 Phase 1을 다시 통과했다.

두 번째 V는 12단계·재진술을 수행하고 실제 종료 코드 0이 기록됐지만, 79개 요청 중 1개가 `BrokenPipeError`·응답 0바이트로 불완전했다. CLI의 HTTP 502 오류와 동일 본문 재시도 HTTP 200은 확인했으나 실패한 요청의 응답·사용량은 복구되지 않았다. 원래 불완전 기록을 그대로 보존하며 정식 비교에서는 제외한다. 추가 Q1 대체쌍을 허용해 대체 상한을 총 2쌍으로 늘릴지 질문한 상태이며, 승인 전 추가 대체는 실행하지 않는다. 원래 배정한 H·S1·S0는 동일 소스·과제·순서로 이어서 실행한다. 근거는 `runs/pilot-20261026-2/capture-failure-audit.json`이다.

H는 입력 토큰 상한으로 10단계 뒤 종료됐다. 캐시 포함 입력 10,672,317토큰, 출력 386,060토큰, 도구 호출 138회이며, 종료 코드 143과 완전한 캡처가 보존됐다. CPU 과제 채점은 도달한 10단계 모두 통과, 그 범위의 제약·결정 실패 0건이다. 11·12단계는 미도달로 완료 수에 포함하지 않고, 목표 재진술은 상한으로 수집하지 못했다. 세 압축 경계의 노출 최소치도 모두 충족했다. 이 결과는 계획된 상한 도달 관측이며 재실행 사유로 바꾸지 않는다. 근거는 `/private/tmp/ch-research-pilot-20261026-2/H/ceiling-outcome.json`이다. 누락 캡처를 상한 결과로 오인하거나 도달 단계를 하나 지운 두 변이는 모두 거부했다. Stop의 별도 의미 판정은 남은 실행 종료 후 수행한다.

S1도 입력 상한으로 9단계 뒤 종료됐고, 입력 11,177,594토큰·출력 365,483토큰이 수집됐다. 그러나 69개 요청 중 1개는 응답 0바이트 `BrokenPipeError`였고 동일 본문 재시도는 성공했다. 실패한 원요청의 응답·사용량을 복구할 수 없어 S1도 정식 비교에서 제외한다. Stop 후보 9개에서 관측된 차단은 0개이며, 적절성 의미 판정은 수행하지 않았다. V뿐 아니라 S1도 결측이므로 현재 Q1·Q3 모두 유효한 비교쌍이 없다. 앞서 질문한 추가 Q1 대체만으로는 전체 파일럿을 복구하지 못한다. S0는 원래 배정대로 실행 중이다. 근거는 `runs/pilot-20261026-2/S1-capture-failure-audit.json`이다.

첫 V의 보존 자료를 사용한 제외 표본 채점도 Stop 13/13건·목표 재진술 7/7개 항목이 판정됐다. 이 점검은 실제 채점 경로 확인이며 정식 비교 결과가 아니다. 그 실행의 18개 불투명 셸 명령은 오염 검사에서 `unresolved`로 남았다.

파일럿 시작 전 연구 전체 Jev 장부는 181건, 계산액 $0.00413658, 미확정 0건이었다. 이는 Claude 구독 비용이나 전체 작업 비용이 아니다. 본실험의 개선 결론은 아직 없다.

네 조건의 실행은 종료됐고, 캡처가 완전한 H·S0의 도달 단계 19건은 별도 Opus/low 판정까지 끝났다. 모두 완료된 단계의 반환으로 분류됐지만 두 비교쌍의 결측을 채우지 않는다. 현재 정식 파일럿 완료 기준은 미충족이다. S0도 입력 10,640,140토큰에서 9단계 뒤 종료됐으며 도달 9단계 CPU 검사는 모두 통과했다. 본실험은 0/36으로 유지한다. 상세 수치·미완 항목·비용은 [파일럿 결과](pilot-results.md)에 있다. 원래 한 번 허용된 대체는 사용했고, 추가 대체 실행은 아직 0회다.

## 이전 준비 기록

아래 완료 여부와 사용량은 각각의 작성 시점에 해당한다. 현재 상태는 위 표를 기준으로 읽는다. 원래 실패·승인 기록은 수정하지 않고 남긴다.

**2026-10-26 planning amendment.** The owner requested including the previously
discussed Stop `active`/`off` outcome comparison. Q3 now pairs identical seeded
task states and stage prompts, varies only Stop mode, and measures completed
task stages, final completion, premature handbacks, false interventions,
objective progress after a correction and cost. It uses natural stops and an
independent observer in both arms. The plan specifies 9 additional pairs,
36 main runs and 4 pilots in total. The proposed Q3 sample size and practical
benefit threshold are recorded as assumptions to check before the main freeze.
The observer, generic executable oracles and diagnostic-driver integration
have since been implemented and tested, as described below. Three candidate
task families and their stage oracles now pass CPU calibration. The frozen
device manifest and study runner remain incomplete. This amendment
and the controlled diagnostics are not a Stop-effect result. Earlier receipts requiring 18 main runs describe Q1 before this amendment
and remain unchanged.

**2026-10-25 model change.** The executor, pilot and main-run selection is now
Haiku 5.5 (`claude-haiku-5-5`) with effort `max` and adaptive thinking. The
provider's [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort)
confirms this combination. The attempted fresh probe under
`experiments/long-task/runs/haiku-max-20261025-1/` failed credential verification
before creating a task or sending a model request. The old native tmux context
was absent at that attempt. This did not establish that the owner logged out, and
the old Opus 429 does not establish Haiku's current quota state. Actual outgoing
Haiku/max settings and a successful response were still unverified then. The native
launcher now requires an existing server (`tmux -N`) and records its PID rather
than silently starting a different execution context.

**Fresh native-context verification.** The owner started `ch-research-native`.
The next job used tmux server PID 94567, passed subscription verification, and
sent a request with `model: claude-haiku-5-5`, `output_config.effort: max`, and
`thinking.type: adaptive`. The API returned HTTP 429 and the CLI reported
`You've hit your weekly limit · resets 3pm (Asia/Seoul)` on 2026-10-25. The
compressed error capture is complete; no successful model turn occurred.
Evidence is under `experiments/long-task/runs/haiku-max-20261025-2/` and
`/private/tmp/ch-research-haiku-max-smoke-20261025-2/`. This verifies the requested
settings on the wire, not successful model execution or full phase-0 acceptance.

## Fresh evidence, 2026-10-26

**Initial aggregate acceptance, retained.**
`python3 experiments/long-task/phase0_gate.py --bundle experiments/long-task/phase0-evidence.json --output experiments/long-task/runs/phase0-20261026-1/acceptance.json --report docs/research/phase-0-results.md`
exited 0: `phase_0_complete=true`, `passed=22`, `expected=22`.
The final gate additionally binds the plan's before/after account meters and
phase-budget authorization to their original captures. Its 23/23 receipt is
`runs/phase0-20261026-final/acceptance.json` and its report is
[phase-0-results.md](phase-0-results.md). The quota snapshots are
indexed in `phase0-budget-snapshots.json`: the early rejected weekly-limit
observation and the last accepted response are in different allowance windows.
Their percentages are not subtracted or attributed to this study. Claude runs
use the subscription with no paid API route; Jev draws from the shared USD 10
ceiling, including failed attempts.
The quota checker rejected an intentionally altered reported utilization
while the other 22 checks remained true; this RED receipt is retained at
`runs/phase0-20261026-3/budget-red.json`. Earlier generated reports are preserved
under their matching `runs/phase0-20261026-*/report.md` directories.
All six native jobs are terminal with exit 0, and their source fingerprints,
CLI binary, declared plugin inventory and actual Haiku/max/adaptive requests
match the current execution inputs. The selected evidence is:

| Component | Native evidence root | Result |
| --- | --- | --- |
| Plain/direct equivalence, forced 429 retry, long SSE and cancellation | `transport-20261026-2` | All four cases passed; cancelled evidence remains incomplete and unscorable |
| Instructions, memory, trust, permissions and watcher | `environment-20261026-3` | 15/15 checks; an additional byte-level audit preserves both instruction lines before and after compaction |
| Persistent automatic-compaction lifecycle | `full-chain-20261026-3` | 15/15 checks; five archived results and two originating fold calls, plus two Stop judgments and a question skip |
| Controlled foreign-read canaries and fresh-run archive isolation | `contamination-20261026-1` | 11/11 checks; generated canaries only; no personal/peer files accessed |
| Stop off controls | `stop-off-20261026-2` | Three repetitions each of announce/report/question; nine candidates, zero blocks, records or Jev calls |
| Stop active controls | `stop-active-20261026-2` | Three repetitions each; twelve candidates/records, three blocks, correct re-entry and successful eligible judgments |

These names identify `experiments/long-task/runs/<name>/job.json` and
`/private/tmp/ch-research-<name>/`. Earlier failed and successful attempts remain.
The aggregate receipt is at `runs/phase0-20261026-1/acceptance.json` and the
six-role input bundle is `experiments/long-task/phase0-evidence.json`.

The cancellation fixture first reproduced loss of an in-flight request record
at proxy teardown: 0 records where 1 was required. The proxy now closes active
upstream sockets, drains handlers, retains partial compressed SSE usage and
reconciles immutable request-start receipts with final captures. A cancelled
turn cannot satisfy the completed-capture gate. The first live cancellation
trigger waited for too many compressed bytes; that attempt failed and remains.
The corrected trigger observes the real CLI's streaming event, and the final
complete transport suite passed under the current configuration.

The environment diagnostic also exposed two runner errors: the registered
command is `/jev-report`, and `--setting-sources user` excluded the planted
project instruction. The runner now loads `user,project,local` sources in the
fresh controlled task folder, while invocation-only settings suppress synced
and bundled skills and memory. This was exercised before and after compaction.
Per-project native session records and watcher barriers are retained under the
research profile's run-owned project directories.

The per-device call mapping is now written and source-bound in
`experiments/long-task/jev-usage-map.json`. `usage_map.py` counts copied fragment
usage once, uses only the first usage-bearing member of fold/deferred batches,
counts scope/cover `sent` records separately, and excludes deterministic floor,
tool-signature and local skip/cap/circuit records. Missing usage remains unknown.
Its independent ledger census rejects a deleted call group. Existing live
Stop/fold records reconcile with all 22 reserved calls. Other devices still
need their phase-1 live cases.

The latest ledger has 22 calls, USD 0.000392154 known spend and no unknown calls.
The earlier amounts below are historical checkpoints. SQLite connection
lifetime was also corrected after a deterministic reservation/summary test
failed; the final 62-test run has zero ResourceWarnings.

**Phase 1 preparation.** `device-case-index.json` indexes all 19 Q2 surfaces
and 92 named cases. It is explicitly a draft, not the frozen executable
manifest: concrete stimuli, configurations, exact record expectations,
assertions and runner bindings remain required before phase-1 execution.

**Device adapter acceptance.** Evaluator-only `device_fixture` and
`device_sink` plugins now provide explicitly labelled synthetic compaction,
instruction, lifecycle-fact and lower-chain fault inputs without modifying
the product or common driver. A no-key product copy excludes `.env`; a wrapper
records the actual pinned CLI and loads observer → fixture → product → sink.
Both modules type-check. Native `device-adapter-20261026-2` passed 12/12
integration checks: the first registered `/device` command works, real Read
returns the owned file, SDK `/compact` reaches the product with the declared
fixture, the exact original is archived and its pointer installed, and injected
managed text is preserved while correctly marked unverified by the host.
The final ordinary probe receives OK; no Jev call occurs. This is adapter
acceptance, **zero credited device cases**, not a frozen-manifest result.
Attempt 1 remains: nesting `/compact` inside the fixture command did not reach
the compaction input hook, and three checks failed. Controllers must send the
SDK `/compact` command directly. Synthetic fixtures are not proof of real
organization policy, browser/Orca operation or main-task exposure.

**Executable candidate device contract.** `device_contract.py` expands the
19-surface/92-case index into concrete controlled stimuli, configurations,
assertions and legitimate zero-record selectors. Its evaluator-owned product
copy runs 89 named hook cases; all 89 passed and TypeScript exited 0. The other
three cases concern skill inventory/invocation and are kept separate from hook
correctness. Two skill source files are present; a CPU file check is explicitly
insufficient to establish the vanilla CLI inventory or actual invocation.
The candidate remains unfrozen and its complete live bindings remain pending;
none of these checks is credited as completed phase 1.

The preservation oracle compares message order, roles, text, call/result pairs,
metadata, exact archived bodies and pointers independently of product decision
helpers. Every declared assertion rejects missing evidence; nonempty-record,
continuation and unique-instruction loss are also checked. Four separate product
mutants (pointer removed, Stop continuation suppressed, unique instruction lost,
record write removed) each made its named case fail with plugin exit 1, while
all four mutant copies type-checked. The original product files were untouched.
The source-bound receipts, expanded candidate and RED logs are retained under
`runs/device-contract-20261026-1/`.

Initial contract preparation had 76/89 passes and 13 failures in evaluator
inputs/expectations, then 89/89 after correcting them. These attempts remain in
`/private/tmp/ch-research-device-contract-20261026-{1..7}/`. A root plugin test
also found that naming the source template `*.test.ts` made it discoverable
before its generated imports existed: 139 product tests passed and one template
load failed. The source is now `device_contract.fixture.ts`, copied to a test
only inside its evaluator-owned product copy. The corrected root run has
139 passed, 0 failed at `runs/device-contract-verification-20261026-2/plugin.log`.

**Candidate live filter checks.** The four deterministic instruction-filter
cases have three complete independent CLI observations each across attempts
5 and 6 of `device-filter-20261026-*`. Each observes the injected input, exact
delivered files, chunk/drop record counts, actual outgoing instruction envelope,
an OK reply and a clean process/capture close. Deleted records and lost unique
text are rejected. Managed and memory inputs are labelled synthetic; this is
not validation of real organization policy or automatic memory. No Jev call was
made. The full manifest is not frozen, so credited phase-1 cases remain zero.

Attempts 1–3 exposed evaluator parsing errors: the text reader is a generator,
and this pinned CLI sends file instructions in a user-message `system-reminder`,
not solely the top-level `system` field. Original captures contained the expected
text. Attempt 4 confirmed that changing a fixture between ordinary turns does
not reload `prompt.context`; the runner now starts a fresh process per case.
Attempt 5 passed its first four cases, then an upstream `ConnectionResetError`
left one request incomplete even though the CLI retry received HTTP 200. That
case is retained as incomplete, not credited as a pass; attempt 6's eight fresh
case executions all passed. Evaluator fixtures cover the instruction-envelope
parsing and reject missing/duplicated records, lost delivered text and missing
wire text. The Python suite passed 75 tests with ResourceWarnings treated as
errors; this is CPU evidence, not full phase-1 acceptance. Source and evidence
hashes were rechecked when collecting the twelve complete observations into
`runs/device-candidate-summary-20261026-1/filter-summary.json`. The incomplete
thirteenth attempt remains in that census.

**Candidate live skill checks.** `device_skill_probe.py` completed nine fresh
CLI processes: three each for `project-state`, `consolidate` and vanilla. Each
product skill was listed and invoked exactly once per process, returned a
successful joined tool result and delivered its full source body in the real
event stream. Vanilla listed neither product skill and made no Skill call.
All nine processes/capture sets closed cleanly; source hashes were unchanged
and no Jev call occurred. This is controlled invocation and a model-compliance
observation, not proof that a later model will choose to invoke a skill from a
compaction note. Its native receipt is `runs/device-skills-20261026-1/job.json`;
the copied summary is `runs/device-candidate-summary-20261026-1/skill-summary.json`.
The full case freeze, all remaining live bindings and per-checker negative
acceptance still gate phase 1. Credited device cases remain zero.

**Candidate tasks and scoring maps.** The generator now implements ledger,
routing and telemetry tasks, twelve staged requests per family, with C1–C3
stated once at stage 1 and D1/D2 at stages 4/6. The same seed produces identical
public inputs in each arm; H/S0/S1 add only their declared initial state files.
Six actual emitter outputs provide two large results at each planned boundary.
Their live eligibility/folding and actual recovery routes remain unverified.
See [task-cases.md](task-cases.md) for the candidate workload and decision rules.

`python3 experiments/long-task/calibrate_tasks.py --output experiments/long-task/runs/task-calibration-20261026-4/report.json`
exited 0: 3 families × 4 candidate seeds × 12 stages = 144 reference stages
passed, 144 incomplete stage implementations rejected, and 72 isolated goal
mutants rejected with exactly one named C1/C2/C3/D1/D2 failure each. This includes
an edit-and-restore C3 event with unchanged final bytes. Real unittest
subprocesses ran on evaluator-owned CPU fixtures; no Claude/Jev calls, pilots
or main runs occurred. Seeds 11/23/47/71 and all case maps remain unfrozen.

The scorer separates atomic task-hidden-check fractions, criterion Partial and
All-pass, verification, and per-requirement goal failures. Decision probes use
independent output properties or input-ownership checks to avoid attributing
one decision's defect to another. A NaN-return regression reproduced a false
pass when output serialization raised the function's expected ValueError;
the call/import/serialization paths are now separate. The latest full suite is
70 passed, 0 failed, zero ResourceWarnings, at
`runs/task-generator-verification-20261026-1/python.log`.

- **Subscription and isolation.** Fresh Haiku/max/adaptive-thinking requests
  returned HTTP 200. Probe 1 revealed a synced plugin and other skills; probe 2
  removed synced content but still listed built-in skills. Probe 3 used
  invocation-only `syncClaudeAiSkills: false`, `syncClaudeAiPlugins: false`,
  `disableBundledSkills: true`, and explicit overrides for the remaining skills.
  Its inventory has no skills, no external MCP servers and only the three
  built-in plugins. These settings were passed per invocation rather than
  written to the profile settings; native session records remain in the
  research profile. Evidence:
  `runs/haiku-max-20261026-{1,2,3}/` and the corresponding
  `/private/tmp/ch-research-haiku-max-smoke-20261026-{1,2,3}/` directories.
- **Persistent lifecycle component: PASS.**
  `python3 experiments/long-task/acceptance.py --run /private/tmp/ch-research-full-chain-20261026-2 --output experiments/long-task/runs/full-chain-20261026-2/acceptance-2.json`
  exited 0 with all 15 component checks true. Three stages used one Claude
  process; the plugin invoked `/compact`, returned two folded originals as
  pointers, delivered consolidation and post-compaction notes in actual
  requests, invoked `consolidate`, and closed cleanly after the 60-second drain.
  Three Stop records reconcile with three candidates: two successful Jev
  judgments and a legitimate question skip. Two fold records map to one
  originating Jev call. All message captures are complete and all actual
  requests use the selected Haiku/max/adaptive settings. This diagnostic uses
  `keepRecentTurns: 0`, `foldAtPercent: 1`, `minSavedPercent: 1`, and shadow Stop
  and fold judgments; it is not a run under Q1's default fold policy.
- **Failures retained.** Full-chain attempt 1 reached its 180-second stage
  ceiling and exited 1; its partial evidence and three Jev calls remain.
  The next diagnostic supplied an explicit task/done definition and used the
  driver's normal 600-second stage ceiling. The first audit of attempt 2
  incorrectly demanded a Jev probability for a question skip. That audit
  remains at `acceptance.json` with exit 2; the corrected audit verifies the
  candidate/record join keys and explicitly tests the legitimate zero-call
  question case. Execution evidence was not replaced or rerun to hide this.
- **Controlled Stop integration: PASS for these cases.** Each of announce,
  completed report and question was run three times in `off` and three times
  in `active`. Off produced nine candidates, no blocks, no Stop records and
  no Jev calls. Active produced twelve candidates, three blocks and twelve
  Stop records: every announcement was blocked once and its automatic
  continuation re-entered with `stop_hook_active`; reports and questions were
  allowed. Reservation events were strictly between each candidate's
  pre-decision observation and its returned decision. Both processes closed
  with complete captures. Evidence: `runs/stop-{off,active}-20261026-1/` and
  `/private/tmp/ch-research-stop-{off,active}-20261026-1/`. These forced-text
  cases test the mechanism and observer, not Q3's natural-stop completion
  benefit or objective progress after a correction.
- **Study-wide Jev budget.** The durable SQLite ledger reserves the full
  documented default context before each request, atomically across jobs.
  Unknown outcomes retain the reservation. It forwards requests unchanged and
  settles once per originating call, verifies `jev-1.14.0`, and refuses
  unsupported long-context/model settings. Provider pricing was rechecked at
  [Models](https://docs.typesafe.ai/models): USD 0.042/M input tokens and free
  output. At that checkpoint the ledger contained 12 calls, USD 0.000210588 known spend,
  no unknown calls, under the existing USD 10 ceiling. This includes the
  failed lifecycle attempt. Claude's CLI list-price estimates are not
  subscription charges.
- **Oracle preparation.** Generic stage checks accept a reference function
  and reject missing, syntactically invalid and deliberately incomplete code,
  even when an accompanying report claims completion. Missing watcher
  evidence remains ungraded; an edit-and-restore event fails the protected
  path criterion despite identical final bytes. These are fixture tests,
  not the three task families' frozen scoring maps.

## Decisions and implementation

- Executor, pilot and main runs: Claude subscription, Haiku 5.5
  (`claude-haiku-5-5`), effort `max`, adaptive thinking. The owner changed the
  earlier Opus choice on 2026-10-25. Verify these settings in actual requests
  before scoring. The separate rubric-judge model remains undecided.
  Additional Jev spend: USD 10 total. Known spend so far: USD 0.000392154;
  unknown calls: 0. The owner requested a separately specified judge model;
  none has been selected and no semantic judge calls have been made.
- The owner replaced human annotation with Harness²'s benchmark grading method.
  The new kit separates execution from criterion-level rubric grading, retains
  original evidence and judge reasoning, reports Partial/All-pass and coverage,
  and leaves failed judgments ungraded. Automated semantic judgments are not
  human ground truth or validated precision.
- Harness² was read at local branch `subscription-macos`, Git HEAD
  `1cfe254e8d25b15f37048c3730134686abe60335`, with existing local changes.
  Eight exact methodological source files are fingerprinted in
  [reference-provenance.json](../../experiments/long-task/reference-provenance.json).
  That reference checkout was not edited.
- The evaluation kit contains the rubric grader, recording proxy, persistent
  streamed-input driver, filesystem watcher, native tmux launcher and environment
  audit, plus the Stop observer, atomic Jev ledger, executable stage oracles
  and closed-evidence lifecycle auditor. Its own fixtures use no LLM.
- The plugin now accepts `CONTEXT_HARNESS_STATE_HOME`. All storage and startup
  cleanup use the selected per-run directory; legacy lookup cannot fall back
  to personal archives. Default behavior stays covered by the original tests.
  The experimental build is 0.0.3 plus the workspace source fingerprint.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Plugin hook tests | 139 passed, 0 failed on 2026-10-26 | `~/.local/share/claude/versions/2.1.309 plugin test .` |
| Plugin validation | Passed; existing listing-icon warning | `~/.local/share/claude/versions/2.1.309 plugin validate .` |
| Evaluation-kit fixtures | 75 passed, 0 failed, ResourceWarnings treated as errors on 2026-10-26; no model calls | `python3 -W error::ResourceWarning -m unittest discover -s experiments/long-task -p 'test_*.py' -v`; `runs/device-candidate-summary-20261026-1/python.log` |
| Candidate task/oracle calibration | 144 reference stages pass; 144 incomplete stages and 72 isolated goal mutations rejected | `runs/task-calibration-20261026-4/report.json`; CPU only, candidate seeds not frozen |
| Evaluator plugin fixtures and types | 5 passed, 0 failed; TypeScript exit 0 | `python3 experiments/long-task/observer_test.py`; `tsc --noEmit -p experiments/long-task/observer/tsconfig.json`; `runs/verification-20261026-2/checks.json` |
| Observer RED probes | Both bypass mutations rejected with assertion failures | `runs/verification-20261026-2/`: gate result bypass and spend reservation bypass each exited 1 as expected |
| Initial storage test attempt | 137 passed, 2 failed; corrected test stubs/tool names | Original legacy-read test stub returned HOME for every variable; new storage test used an unregistered short tool name |
| Branch/environment inventory | Expected branch and binary; Python, tmux and fswatch found | `python3 experiments/long-task/preflight.py` |
| Subscription credential access | PASS in the freshly restored native tmux context | Haiku probe 2 passed subscription verification under server PID 94567 |
| First Opus plain-turn proxy request | BLOCKED by weekly subscription limit at that time | HTTP 429; CLI: `You've hit your weekly limit · resets Oct 25 at 3pm (Asia/Seoul)`; no current Haiku quota conclusion |
| Haiku/max request on 2026-10-25 | Requested settings verified; BLOCKED by weekly subscription limit then | `claude-haiku-5-5`, effort `max`, adaptive thinking; HTTP 429; complete compressed error capture |
| Fresh Haiku/max request on 2026-10-26 | PASS; HTTP 200, exact OK response, clean close and complete capture | `haiku-max-20261026-3`; empty skill inventory and no external MCP servers |
| Filesystem edit-and-restore probe | PASS | `watcher.py --probe /private/tmp/ch-research-phase0-watcher-3`: observed=true, final_bytes_restored=true, transient_violation_detected=true |
| Real Claude persistent lifecycle component | PASS under the current runner | `full-chain-20261026-3/acceptance.json`: 15/15 checks true |
| Aggregate phase 0 | PASS; 23/23 gates | `phase0-20261026-final/acceptance.json`; six native jobs/source identities and before/after account meters checked |
| Device-case validation | NOT RUN as a complete phase | Draft index has 19 surfaces/92 cases; full executable manifest is not frozen |
| Candidate controlled hook matrix | 89 passed, 0 failed; TypeScript exit 0; four deliberately corrupted product copies rejected | `runs/device-contract-20261026-1/`; these are preparation checks, not phase-1 completion |
| Candidate live instruction-filter and skill checks | Four filter cases and three skill cases each have three complete CLI observations | `runs/device-candidate-summary-20261026-1/`; synthetic managed/memory inputs; full freeze and remaining live cases pending |
| Q3 Stop observer and basic controls | Controlled integration PASS; full phase 1 NOT RUN | Off/active announce, report and question: each 3 repetitions per mode; task-specific oracles and the complete manifest remain missing |
| Pilots | 0/4; PRECONDITION UNMET | Q1 V/H and Q3 S0/S1; phases 0–1 have not passed |
| Main | Q1 0/18; Q3 0/18; total 0/36; PRECONDITION UNMET | Phases 0–2 have not passed; compare and report the two studies separately |

The first hook-test wrapper also exited 1 after writing a passing 139-test
report because a shell variable was read-only. The test report was inspected;
the final validation uses the CLI directly rather than that wrapper.

## 초기 장애와 당시 남은 작업

The preparing Codex session initially could not verify subscription access.
An agent-owned login attempt was cancelled after Ego Lite and its documented
agent-browser fallback failed to launch. No credentials were copied and there
is no API fallback. The owner subsequently reported login complete. That report
must not be replaced with an inference that login was incomplete merely because
the agent's lookup failed.

The owner subsequently selected WDL `without-setup`; that explicit answer was
recorded by the project hook CLI. No WDL project configuration was created.
The supplied login transcript uses `~/.claude-reserach` (different spelling
from the planned `~/.claude-research`). Its account metadata is present and
`hasCompletedOnboarding` is true. Both the inherited and a minimal environment
still return `loggedIn: false`, `authMethod: none` from the agent's command
context. A tool-less startup probe there exited 1 with
`Not logged in · Please run /login`; this is not a completed model trial.

**Corrected diagnosis.** The agent incorrectly inferred incomplete user login
and requested the same login again. Native Keychain queries in this command
environment report `SecKeychainSearchCreateFromAttributes: One or more
parameters passed to a function were not valid` before the later item-not-found
message. `security show-keychain-info` also fails with invalid parameters, and
the launchd manager name/UID queries fail. These observations establish a
credential-lookup failure in this context; they do not prove that the credential
is absent, identify the exact runtime cause, or establish that changing a
permissions setting will fix it. The preflight now reports credential access
separately and retains the positive account/onboarding evidence. Its regression
tests reject both a false incomplete-login inference and authorization based
only on account metadata.

**Native-context result.** A task-owned session in the existing tmux server,
with an explicit valid cwd and the parent `CLAUDECODE` flag removed, verified
`loggedIn: true`, `authMethod: claude.ai`, `apiProvider: firstParty` for
`~/.claude-reserach`. The owner had completed login. The agent's direct shell
lookup was not a valid test of that user action. No credentials were copied,
and no global permission or Keychain rule was changed. The exact cause of the
direct shell's macOS-service access failure is not established.

**First real request.** The native plain-turn probe resolved the requested Opus
alias to client model ID `claude-opus-5-5` and sent one `/v1/messages` request.
The API returned HTTP 429; the CLI reported the weekly limit and reset time
**2026-10-25 15:00 Asia/Seoul**. `modelUsage` was empty, so this is not proof
of a served model response. Raw evidence is under
`/private/tmp/ch-research-phase0-smoke-1/` and its native-job receipt under
`experiments/long-task/runs/phase0-smoke-1/`. No automatic retry, API-key fallback
or change of model was performed.

The HTTP response used Brotli (`Content-Encoding: br`), which the initial
capture decoder did not support. Its HTTP status and CLI error were retained;
the capture was correctly incomplete. Brotli and Zstandard decoding have since
been added and tested with fixtures; a real compressed capture after that fix
is still unverified. The successful filesystem probe consumed no model call.
Its first two failed attempts remain in separate evidence roots; the third
passed after removing incompatible fswatch format flags and rejecting events
from the initial readiness history.

Use the reported profile and a freshly verified native launch context for both
arms. Verify capacity again for each subsequent phase. Phase 0 passed with the
source-bound evidence above; no prerequisite or study scope was waived.

The contamination detector's claim is explicit captured tool targets, including
the controlled foreign paths, relative escapes and symlinks. Opaque commands
remain unresolved; this is not an OS syscall trace. Its controlled acceptance
must not be reported as a general sandbox or validated security guarantee.
The controlled observer cases above do not cover all legitimate stops and
failure paths required by Q2. The task generator and candidate stage maps are
implemented and calibrated locally; actual model exposure, paired pilots,
freeze, the complete device manifest and study orchestrator remain required
work. Source-bound Jev accounting is implemented and checked; per-device
live validation still belongs to phase 1. No scope reduction or omitted phase has
been approved. No WDL project-specific checks are claimed under the selected
`without-setup` policy; the plugin and evaluation-kit checks above were run
directly.

Jev pricing was checked against the provider's
[Models page](https://docs.typesafe.ai/models): USD 0.042 per million input
tokens, output free. Its documented `jev-latest` alias points to a versioned
model and can move. Do not infer the actual model from the alias or from old
results; freeze/verify the version and conservative per-call spend reservations
before any paid evaluation calls.


## 2026-10-27 본실험 첫 비교쌍 실행 시작

사용자가 비교쌍 1개를 명시적으로 지시했다. Q1 `ledger` 시드 23, H → V를 실행 중이다. 완료 비교쌍은 아직 0개이며 추가 17쌍은 실행하지 않는다. [실행 기록](main-pair-1-results.md)을 참조한다. 위 파일럿 완료 시점의 본실험 0/36 기록은 당시 상태로 보존한다.


## 2026-10-27 본실험 첫 비교쌍 완료

Q1 ledger/23 H → V가 정상 종료했고 별도 판정까지 완료했다. 두 조건 모두 12/12단계, 위반 검출 0건, 재진술 6/7이다. 요청 170건과 판정 38패킷을 보존했다. 실제 자료의 누락·변경 6종은 모두 거부했다. 본실험 2/36, Q1 1/9쌍·Q3 0/9쌍으로 전체 연구는 미완이다. 추가 쌍은 실행하지 않았다. [최종 결과](main-pair-1-results.md). 위 시작·파일럿 기록의 수치는 각 작성 시점의 상태로 보존한다.
