사용자 요청에 따라 본실험 첫 Q1 비교쌍의 토큰 증가 원인을 상세 보고합니다.

보고서: /Users/jaesolshin/Documents/GitHub/context-harness/docs/research/token-overhead-diagnosis.md
원본 대응 분석·검증: /Users/jaesolshin/Documents/GitHub/context-harness/experiments/long-task/runs/main-20261027-1/token-diagnosis/ (analysis.json, supplement.json, verification.json, analyze.py)

확인한 핵심:
1. H 입력 18,511,450 대 V 8,403,740(+120.3%), 출력 +58.5%, 과제 시간 45.8 대 30.2분. 둘 다 12/12, 위반 검출 0, 재진술 6/7입니다.
2. H의 session.compact는 3회 모두 도구 결과만 접고 기본 요약을 생략했습니다. V는 기본 요약 3회를 수행했습니다. H는 압축 전 기존 추론 블록 12/12·34/34·54/54를 그대로 다음 요청에 보존했고 V는 각 경계에서 0개였습니다. 마지막 요청 입력은 H 448,382 대 V 173,960, 추론 서명 문자열은 약 203만 대 35만 자입니다. 양쪽 clear_thinking keep: all 설정은 같습니다.
3. 접기 자체는 36결과·211,624 UTF-16자 절약으로 작동했습니다. 그러나 정본 파일 관리 38호출, consolidate Skill 1회, read_coordinate 11회가 추가됐고 ToolSearch도 1회였습니다. 전체 도구 호출은 H 184 대 V 98입니다.
4. 증가분의 93.8%는 캐시 읽기 입력입니다. 단계별 산술 분해에서 93.7%는 요청당 평균 입력 차이 항입니다. 이는 추론 블록의 인과 기여율을 계산한 수치가 아닙니다. HTTP 기록은 85/85지만 V에 count_tokens 2건이 있어 실제 생성은 H85/V83입니다.
5. 동결 register.ts:235–285의 선택적 기본 요약 분기, fold.ts:276–304의 원래 메시지 핸들 보존, fold.ts:307–316의 텍스트 기반 크기 추정, fold-flow.ts:50–62의 압축 후 정본 재읽기 안내를 실제 전송 기록과 연결했습니다. 스냅샷 소스는 evidence-packet/sources/ 아래에 있습니다.

주의: post_tokens와 다음 API 입력은 범위가 달라 차이만으로 계수 버그를 단정하지 않았습니다. 정확한 크기였다면 60% 분기가 달라졌는지도 미확인입니다. 서명 문자를 토큰으로 임의 환산하지 마세요. 보고서 7절에 실제 입력 예산, 정본 관리 작업량, 복구 범위, 전송량 회귀 검사 순서로 수정 검토 항목을 적었습니다.

분석 중 제품 코드·설정·원본은 수정하지 않았고 새 모델/API 요청도 0회입니다. 170개 HTTP 기록(생성168·계수2)을 전수 분류했고 원본 보존 3,835파일 해시가 일치했습니다. 이번 메시지는 사용자가 요청한 조사 보고 전달입니다.
