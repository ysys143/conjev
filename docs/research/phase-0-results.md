# 실행 환경 검증 — 2026-10-27

최종 세션별 연결 재사용 코드로 23/23 통과했다. 전송·환경·자동 압축 전체 경로·오염 탐지·Stop off·Stop active의 6개 네이티브 작업은 모두 exit 0이다.

| 검사 | 결과 |
| --- | --- |
| `contract_and_checkout_current` | PASS |
| `all_six_native_jobs_terminal_success` | PASS |
| `all_component_receipts_pass` | PASS |
| `all_recorded_inputs_match_current_sources` | PASS |
| `pinned_cli_binary_matches` | PASS |
| `subscription_launches_have_no_api_key_source` | PASS |
| `actual_requests_use_haiku_max_adaptive` | PASS |
| `only_declared_plugins_and_skills` | PASS |
| `proxy_no_proxy_equivalence` | PASS |
| `forced_error_retry_with_and_without_proxy` | PASS |
| `live_long_sse_stream` | PASS |
| `cancelled_stream_preserved_as_incomplete` | PASS |
| `persistent_driver_full_chain` | PASS |
| `instructions_preserved_before_and_after_compaction` | PASS |
| `automatic_memory_absent_and_unwritten` | PASS |
| `first_party_trusted_proxy_classification` | PASS |
| `read_edit_and_test_permissions` | PASS |
| `transient_prohibited_action_watcher` | PASS |
| `teardown_and_controlled_contamination` | PASS |
| `stop_observer_ordering_and_basic_controls` | PASS |
| `source_bound_jev_usage_map_and_call_census` | PASS |
| `global_jev_spend_within_approved_ceiling` | PASS |
| `phase_budget_and_before_after_account_meters` | PASS |

근거는 [acceptance.json](../../experiments/long-task/runs/phase0-20261027-3/acceptance.json), [입력 묶음](../../experiments/long-task/phase0-evidence-20261027-3.json), [계정 지표](../../experiments/long-task/phase0-budget-snapshots-20261027-3.json)다. 대용량 요청 별도 검사는 최종 소스로 64/64, 연결 1개·재사용 63회였다. 취소한 스트림은 미완전으로 거부했고, 강제 429와 실제 CLI 재시도·긴 SSE 전달·직접/중계 응답 동등성을 확인했다.

이 환경 검사는 장치 또는 성능 효과를 대신하지 않는다. 현재 파일럿의 두 비교쌍과 구체적 한계는 [파일럿 결과](pilot-results.md)에 있다. 동일한 계정의 기록은 연구 비용으로 차감하지 않는다. 로그인·자격 증명 복사·전역 권한 변경은 실행하지 않았다.
