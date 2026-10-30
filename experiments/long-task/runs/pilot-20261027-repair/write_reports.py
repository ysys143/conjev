"""Write the local Markdown reports from admitted original measurements."""
import json
import shutil
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = Path('/Users/jaesolshin/Documents/GitHub/context-harness')
HERE = REPO / 'experiments/long-task'
run = HERE / 'runs/pilot-20261027-2'
root = Path('/private/tmp/ch-research-pilot-scoring-20261027-1')
d = json.loads((run / 'report-data.json').read_text())
if not d['pilot_complete'] or d['acceptance']['valid_pairs'] != {'Q1': 1, 'Q3': 1}:
    raise ValueError('The pilot is not admitted')
now = datetime.now(ZoneInfo('Asia/Seoul')).isoformat(timespec='seconds')
for name in ['pilot-results.md','phase-0-results.md','phase-1-results.md','evaluation-progress.md']:
    source = REPO / 'docs/research' / name
    target = run / ('previous-' + name)
    if not target.exists():
        shutil.copyfile(source, target)

labels = {'V':'기본 조건 + 공통 관찰기','H':'harness, Stop shadow','S1':'harness, Stop active','S0':'harness, Stop off'}
table = []
for arm in ['V','H','S1','S0']:
    row = d['actors'][arm]; result = row['result']; score = row['scores']
    table.append(f"| {arm}: {labels[arm]} | {result['completed_stages']}/12 | {result['goal_failures']} | {row['restatement_passed']}/{row['restatement_graded']} | {score['stop_graded']}/{score['stop_expected']} | {row['usage']['input_tokens']:,} | {row['usage']['output_tokens']:,} | {result['task_wall_seconds']/60:.1f} |")
jev = d['jev_global']; pilot_jev_calls = sum(r['calls'] for r in d['jev_pilot']); pilot_jev_spend = sum(r['known_spend_usd'] for r in d['jev_pilot'])
before = d['account_meters']['before']; after = d['account_meters']['after']
pct = lambda value: f'{float(value)*100:g}%'
report = f'''# 파일럿 실행 결과 — 2026-10-27

파일럿 완료 기준을 충족했다. 새 사양의 네 조건을 끝까지 실행했고 Q1(V/H)·Q3(S1/S0)에서 각각 유효한 비교쌍 1개를 확보했다. 48개 단계는 모두 과제·검증 기준을 통과했고, 제약·결정 위반 검출은 0건이었다. 본실험은 0/36이다.

기준 시각은 {now}다. 과제는 `ledger`, 시드는 `71`, 순서는 V → H → S1 → S0였다. 실행은 `claude-haiku-5-5`/`max`/adaptive, 별도 판정은 `claude-opus-5-5`/`low`, 모두 구독 경로다. CLI는 2.1.309, 실행 사양은 버전 4다. 작업 트리는 `experiment/fold-recovery`, HEAD `9403c5fe7be802ee990f149a1a45d888cf556672`와 미커밋 변경이며, 정확한 입력은 소스별 해시로 식별한다.

| 조건 | 과제 완료 | 제약·결정 위반 | 재진술 통과/판정 | 과제 Stop 판정 | 입력 토큰 | 출력 토큰 | 과제 시간(분) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
{chr(10).join(table)}

입력은 입력·캐시 생성·캐시 읽기의 합이다. 표의 토큰은 마지막 재진술까지 포함하며, 시간은 재진술 전 12개 과제 단계와 압축에 쓴 실제 단조 시계 측정값이다. 과제 시간과 전체 종료·채점 시간은 다르다. 네 조건의 실행 요청 {d['fresh_known_usage']['captured_requests']}건은 모두 응답·사용량이 완전하고 실제 종료 코드는 0이다.

## 두 비교의 관측

Q1은 V/H 모두 12/12 완료, 제약·결정 위반 0건으로 차이가 없었다. 재진술은 V 6/7, H 7/7이다. 별도 판정은 V가 원래 지시문에 없는 추가 보호 파일 목록을 사용자 제약처럼 반환했다고 분류했다. 이는 이 응답에 대한 자동 판정이며 사람 정답률이나 일반적인 기억 성능을 뜻하지 않는다.

Q3도 S1/S0 모두 12/12 완료, 위반 0건이었다. 실제 S1 차단 1회는 11단계의 완료 보고에 발생했다. 차단 직전 단계 검사도 모두 통과했고, 별도 판정은 `completed`로 분류했다. 자동 재진입 후에도 추가로 충족된 과제 기준은 0개였다. 따라서 이번 파일럿에서는 완료 단계 증가가 관측되지 않았고, 완료 보고를 막는 잘못된 개입 1회가 관측됐다. 올바르게 가로챈 조기 반환 뒤의 진척 효과는 관측되지 않았다.

과제 단계의 Stop 후보 {sum(r['scores']['stop_expected'] for r in d['actors'].values())}건을 모두 판정했다. 재진술 질문에서 생긴 Stop 후보는 과제 완료 시점 이후라 이 수에 합치지 않았으며 원래 관찰 기록에는 남아 있다. 네 조건의 압축 경계 3곳은 모두 결과 2개·합계 4,000자 노출 최소치를 충족했다. 이 노출은 장치가 사용할 기회를 확인한 것이며 개별 복구 장치의 인과 효과를 증명하지 않는다.

각 비교는 한 과제·한 시드의 파일럿 1쌍이다. 시간·토큰 차이를 일반적 성능 개선으로 확장하지 않고 9쌍 본실험의 판정을 대신하지 않는다. 모델 판정은 검증된 사람 정답이 아니다.

## 실행기와 채점기 보완

1. 전송 기록기가 요청마다 새 외부 연결을 만들던 경로를 세션별 HTTPS 연결 재사용으로 바꿨다. 최종 코드의 1MB 이상 요청 64회는 연결 1개·재사용 63회로 통과했고, 실제 파일럿 요청 323건도 누락 없이 수집됐다. 응답 헤더·압축된 본문과 재시도 정보는 그대로 전달한다. 중간에 끊긴 HTTP 응답은 완료로 받아들이지 않는다. 이전 연결 끊김의 네트워크 근본 원인을 확정한 주장은 아니다.
2. 기존 입력 1,000만·출력 50만 상한은 일부 조건을 마지막 단계와 재진술에 이르기 전에 끝냈다. 새 사양은 입력 3,000만·출력 100만, 단계 600초·실행 7,200초·도구 400회를 네 조건에 동일하게 적용했다. 이전 상한 결과는 보존하고 새 자료와 합치지 않는다.
3. 원래 검증 채점기는 작업 폴더 테스트 성공 뒤 임시 복사본에서 일부러 실패시킨 변이 검사까지 마지막 작업 실패로 읽었다. 전체 시도 점검에서 영향 후보 7개 단계가 나왔고, 새 파일럿에서는 V의 1단계가 해당했다. 실제 작업 폴더의 마지막 검사와 격리된 검사를 구분하고, 최종 스냅샷의 비어 있지 않은 테스트도 독립 실행하는 검증 판본 2로 네 조건을 동일하게 재채점했다. V의 원래 11/12 기록은 그대로 남기고 12/12로 교정했다. 검증 외 기준의 판정은 바뀌지 않았다.
4. 재진술의 추가 목표 판정에는 처음에 요약된 목표·제약·결정만 들어가 단계별 지시문이 빠졌다. 초기 판정 중 3개는 자료 부족으로 미판정이었다. 네 조건 모두 같은 기준·같은 응답에 원래 12개 지시문을 추가해 판정했고, 초기 결과와 비용은 보존했다. 근거 인용이 원문과 일치하지 않은 Stop 판정 1건도 거부한 채 남기고, 같은 기준·같은 근거의 첫 형식 유효 응답을 별도 재시도로 채택했다. 유효한 `uncertain` 응답을 좋은 점수가 나올 때까지 반복하지 않았다.
5. S1은 커버리지 확인용 `/tmp/ledger-cover/run_trace.py`를 새로 만들었다. 원래 감사는 이 Write를 외부 자료 유입으로 표시했다. 실제 도구의 파일 생성 성공, 제공한 코드와 실제 파일의 동일 해시, 임시 경로·보호 영역 밖이라는 사실을 확인해 새 임시 산출물로 구분했다. 기존 외부 파일의 읽기·덮어쓰기와 평가기/다른 실행 영역 접근은 계속 거부한다. 불투명한 셸 명령은 `unresolved`로 남겼으며 OS 파일 접근 추적이나 일반적인 보안 보장을 주장하지 않는다.

실행 입력과 원본 스냅샷·원래 채점·첫 모델 응답은 수정하지 않았다. 권위 있는 최종 결과는 검증 판본 2, 원래 지시문을 보충한 재진술 판정, 환경 감사 판본 2를 함께 참조한다.

## 선행 검사와 완료 근거

| 확인 대상 | 결과 | 근거 |
| --- | --- | --- |
| 최종 전송 경로 | 64/64, 연결 1개·재사용 63회 | `transport-pool-20261027-2/probe.json` |
| Phase 0 | 23/23 PASS, 6개 네이티브 작업 exit 0 | `runs/phase0-20261027-3/acceptance.json` |
| Phase 1 | 92개 케이스·각 3회 = 276개 실제 관측 | `phase1-20261027-5/acceptance.json`; 보존 관측 255개 재검증·21개 신규 |
| 결정적 훅·변이 | 89개 통과, 의도한 결함 4종 거부 | 같은 Phase 1의 `deterministic.log`, `red-*.log` |
| 독립 통제 문구 판정 | 36/36 | 같은 Phase 1의 `independent-stop-judgments.json` |
| 기본 평가 도구 | 95개 통과, ResourceWarning 0 | 같은 Phase 1의 `evaluator-tests.log` |
| 검증 채점 판본 2 | 새 검사 13개·기존 오라클 8개 통과, 변이 2종 거부 | `scorer-v2-acceptance-verified.json` |
| 새 임시 산출물 감사 | 검사 7개 통과, 기존 외부 파일·보호 영역을 허용하는 변이 2종 거부 | `scratch-audit-tests.log`, `scratch-audit-negative.json` |
| 최종 완료 검사 | Q1 1/1, Q3 1/1 | [acceptance-final.json](../../experiments/long-task/runs/pilot-20261027-2/acceptance-final.json) |
| 완료 검사 음성 사례 | 원요청·12단계 영수증·원 지시문·재진입·판정 전 스냅샷을 하나씩 누락한 5종 모두 거부 | `negative-acceptance.json`; 임시 복사본에만 적용 |

원래 상태표시줄 검사 9건은 코드·CLI·설정과 보존 해시가 같음을 확인해 재검증했다. 전송 기록기 변경은 그 UI 실행 경로를 사용하지 않는다. 새로 띄운 빈 화면 1회는 정상 자료로 바꾸지 않았고 실패 기록을 남겼다.

## 사용량과 비용

| 범위 | 입력 토큰 | 출력 토큰 | 비고 |
| --- | ---: | ---: | --- |
| 새 실행 모델 네 조건 | {d['fresh_known_usage']['input_tokens']:,} | {d['fresh_known_usage']['output_tokens']:,} | 323건, 미완전 요청 0건 |
| 별도 판정 모델 | {d['judge_known_usage']['input_tokens']:,} | {d['judge_known_usage']['output_tokens']:,} | 최종 Stop 49·재진술 28항목; 거부/보완 시도 포함 82개 패킷 |

이번 네 조건의 Jev는 {pilot_jev_calls}회, 계산액 ${pilot_jev_spend:.9f}다. 연구 전체 장부는 {jev['calls']}회, ${jev['known_spend_usd']:.9f}, 미확정 {jev['unknown_calls']}건이며 설정된 누적 상한 $10 안이다. 이 금액은 사용량·고정 단가 계산이며 청구서 대조액이 아니다. Claude 유료 API 경로는 사용하지 않았고 구독 허용량이나 Codex 작업 비용을 달러로 환산하지 않았다.

실행 직전 계정 지표는 5시간 창 {pct(before['five_hour_utilization'])}·주간 {pct(before['weekly_utilization'])}, 실행 뒤는 {pct(after['five_hour_utilization'])}·{pct(after['weekly_utilization'])}, 모두 `allowed`였다. 공유 계정 지표이므로 차이를 연구 비용으로 계산하지 않는다. 초기 실패 6시도와 그 미확정 사용량은 별도 보존하며 새 네 조건의 추정에 합치지 않는다.

## 원본과 재현 경로

모든 `runs/`는 `experiments/long-task/` 아래다. 다음 파일이 실제 명령·종료 코드·원본 대응 관계를 제공한다.

- [실행·판정 집계](../../experiments/long-task/runs/pilot-20261027-2/report-data.json), [실행 영수증](../../experiments/long-task/runs/pilot-20261027-2/job.json), [초기 판정 영수증](../../experiments/long-task/runs/pilot-20261027-2/scoring-v2-job.json), [인용 검증 재개](../../experiments/long-task/runs/pilot-20261027-2/scoring-resume-job.json), [전체 지시문 보완 판정](../../experiments/long-task/runs/pilot-20261027-2/restatement-completion-job.json)
- [검증 판본 2 검사](../../experiments/long-task/runs/pilot-20261027-repair/scorer-v2-acceptance-verified.json), [원래 검사 영향 범위](../../experiments/long-task/runs/pilot-20261027-repair/verification-scope-audit.json), [최종 음성 검사](../../experiments/long-task/runs/pilot-20261027-repair/negative-acceptance.json)
- `/private/tmp/ch-research-pilot-20261027-2/`: 원래 실행·스냅샷·원래 판정. `/private/tmp/ch-research-pilot-scoring-20261027-1/`: 수정 채점·전체 지시문 판정·환경 감사와 각각의 출처 기록.
- [보존 증거 묶음](../../experiments/long-task/runs/pilot-20261027-2/evidence-packet/manifest.json): 원본 대응 파일을 해시로 대조하는 저장소 내 복사본. 실행 파일은 해시로 식별한다.
- [이전 파일럿 보고서](../../experiments/long-task/runs/pilot-20261027-2/previous-pilot-results.md): 미완 시도와 당시 원인·비용을 보존한 기록.

사용자는 파일럿 재시도 횟수를 제한하지 않았다. 계획의 대체 1쌍 문구를 사용자 승인 한도처럼 적용해 멈췄던 앞선 판단은 잘못이었다. 이번 완료는 자료·채점 경로를 보완해 실제 실행한 결과이며, 본실험·배포·push·PR은 실행하지 않았다.
'''
(REPO / 'docs/research/pilot-results.md').write_text(report)

phase0 = json.loads((HERE / 'runs/phase0-20261027-3/acceptance.json').read_text())
checks = '\n'.join(f"| `{name}` | {'PASS' if value else 'FAIL'} |" for name,value in phase0['checks'].items())
text = f'''# 실행 환경 검증 — 2026-10-27

최종 세션별 연결 재사용 코드로 23/23 통과했다. 전송·환경·자동 압축 전체 경로·오염 탐지·Stop off·Stop active의 6개 네이티브 작업은 모두 exit 0이다.

| 검사 | 결과 |
| --- | --- |
{checks}

근거는 [acceptance.json](../../experiments/long-task/runs/phase0-20261027-3/acceptance.json), [입력 묶음](../../experiments/long-task/phase0-evidence-20261027-3.json), [계정 지표](../../experiments/long-task/phase0-budget-snapshots-20261027-3.json)다. 대용량 요청 별도 검사는 최종 소스로 64/64, 연결 1개·재사용 63회였다. 취소한 스트림은 미완전으로 거부했고, 강제 429와 실제 CLI 재시도·긴 SSE 전달·직접/중계 응답 동등성을 확인했다.

이 환경 검사는 장치 또는 성능 효과를 대신하지 않는다. 현재 파일럿의 두 비교쌍과 구체적 한계는 [파일럿 결과](pilot-results.md)에 있다. 동일한 계정의 기록은 연구 비용으로 차감하지 않는다. 로그인·자격 증명 복사·전역 권한 변경은 실행하지 않았다.
'''
(REPO / 'docs/research/phase-0-results.md').write_text(text)

text = '''# 장치 검증과 재채점 검사 — 2026-10-27

19개 영역·92개 케이스는 각 3회씩 실제 네이티브 관측을 충족해 276개가 통과했다. 현재 판본에서는 코드·CLI·사례 정의·원본 해시가 변하지 않은 255개 관측을 현재 검사로 재검증했고, 입력·스킬 21개는 최종 전송 경로로 새로 실행했다. 276개 전체를 이번에 새로 띄웠다고 주장하지 않는다.

| 확인 대상 | 결과 | 근거 |
| --- | --- | --- |
| 전체 사례 | 92개 × 3회 = 276개 | `/private/tmp/ch-research-phase1-20261027-5/acceptance.json` |
| 보존 관측 재검증 | 일반 장치 246개·터미널 9개 | 각 `replay.json`, `terminal-revalidation.json`; 터미널은 기존 실행 코드·CLI와 봉인 해시 대조 |
| 신규 관측 | 입력 필터 12개·스킬 9개 | 같은 경로의 `filter/probe.json`, `skills/probe.json` |
| 결정적 훅 | 89개 통과 | `deterministic.log` |
| 제품 변이 | 4종 모두 거부 | 포인터·재진입·유일 지시문·기록 제거의 `red-*.log` |
| 통제 Stop 문구 독립 판정 | 36/36 | `independent-stop-judgments.json` |
| 기본 평가 도구 | 95개 통과, ResourceWarning 0 | `evaluator-tests.log` |
| 작업 폴더 검증 판본 2 | 새 13개·기존 오라클 8개 통과, 변이 2종 거부 | `runs/pilot-20261027-repair/scorer-v2-acceptance-verified.json` |
| 새 임시 산출물 감사 | 검사 7개 통과, 외부 기존 파일·보호 영역 허용 변이 2종 거부 | 같은 경로의 `scratch-audit-tests.log`, `scratch-audit-negative.json` |
| 최종 데이터 음성 검사 | 원요청·단계 영수증·원 지시문·실제 재진입·판정 전 스냅샷 누락 5종 거부 | `negative-acceptance.json`; 원본은 수정하지 않고 임시 복사본에 적용 |

파일럿에서 발견한 검증 판정 오류는 작업 폴더의 성공 뒤 임시 복사본의 RED 검사를 실패로 오인한 문제였다. 판본 2는 실제 작업 폴더의 결과와 복사본을 구분하고 최종 스냅샷 테스트도 독립 실행한다. 실제 작업 폴더 테스트 실패, 깨진 최종 코드, 0개 테스트, 알 수 없는 실패 대상은 성공으로 바꾸지 않는다. 검증 외 기준의 결과는 원래와 동일함을 검사했다.

새 커버리지 스크립트를 만든 Write는 기존 외부 파일의 읽기·덮어쓰기와 구분했다. 도구의 새 파일 생성 응답, 입력 코드·실제 파일의 동일 해시, 임시 경로 및 평가기/다른 실행 영역 제외를 모두 요구한다. 확인된 파일만 증거로 보존하고 전체 임시 폴더를 읽기 허용하지 않는다. 불투명한 셸 명령은 미해결이며 OS 추적이나 보안 보장은 아니다.

통제 문구와 장치 사례는 자연스러운 완료 개선의 증거가 아니다. 별도 실제 파일럿에서는 S1이 완료 보고를 1회 차단했고, 차단 전후 추가 충족 기준은 없었다. [파일럿 결과](pilot-results.md)에서 실행 효과와 장치 검증을 구분한다. 모델 분류는 사람 정답률이 아니다.
'''
(REPO / 'docs/research/phase-1-results.md').write_text(text)

progress = REPO / 'docs/research/evaluation-progress.md'
old = progress.read_text()
cut = old.index('### 이전 시도와 판정 기록')
progress.write_text(f'''# 평가 진행 기록

업데이트: {now}.

파일럿은 완료했고 본실험은 0/36이다. Q1·Q3 모두 유효한 비교쌍 1개씩 확보했다. 각 조건의 12단계 과제 검사와 제약·결정 검사에서 과제 미완료·위반은 0건이다. 재진술 28항목은 모두 판정됐으며 V 6/7, 나머지 조건 7/7이 통과했다. S1에서는 완료 보고를 막는 개입 1회가 관측됐다. 단일 파일럿이므로 일반적 성능 개선 결론은 없다.

| 단계 | 현재 결과 |
| --- | --- |
| 실행 환경 | 최종 소스 23/23 PASS |
| 장치 | 92개·각 3회 = 276개; 보존 255개 재검증·21개 신규 |
| 전송 부하 | 64/64, 연결 1개·재사용 63회 |
| 평가 도구 | 기본 95개·수정 검증 새 13개와 기존 8개·환경 감사 7개 통과 |
| 파일럿 실행 | V/H/S1/S0 모두 12/12, 요청 323건 완전 수집·exit 0 |
| 독립 최종 판정 | 과제 Stop 49건·재진술 28항목 모두 판정; 실패·보완 포함 82패킷 보존 |
| 최종 감사 | Q1 1/1, Q3 1/1; 데이터 누락 변이 5종 모두 거부 |
| 본실험 | Q1 0/18, Q3 0/18; 실행하지 않음 |

[결과·비용·한계](pilot-results.md), [최종 감사](../../experiments/long-task/runs/pilot-20261027-2/acceptance-final.json), [수치 집계](../../experiments/long-task/runs/pilot-20261027-2/report-data.json)에 실제 입력·출력 대응을 남겼다. 원래 실패 시도·잘못된 판정·미판정 응답은 삭제하거나 성공으로 덮지 않았다. 사용자가 재시도 횟수를 제한했다는 앞선 설명은 잘못이었다.

''' + old[cut:])
print(json.dumps({'reports_written':4,'pilot_complete':True,'valid_pairs':d['acceptance']['valid_pairs']}))
