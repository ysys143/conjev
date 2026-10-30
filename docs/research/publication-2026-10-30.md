# 실험 변경 병합 확인 — 2026-10-30

실험 브랜치의 미커밋 코드·테스트·계획·결과·원인 분석을 커밋하고, 최신 conjev `main`(5a75db9)과 통합했다. context-harness 0.0.3 당시 결과는 과거 빌드의 측정으로 명시하고 현재 제품의 기본값·이름·상태 이관을 보존했다.

연구용 상태 경로 선택은 현재 `.conjev/state/` 구조에 결합했다. 선택된 상태에서는 개인·이전 상태의 이관·조회·정리를 하지 않으며, 기존 기본 경로의 동작은 바꾸지 않았다. read_coordinate의 거부 결과와 관련 테스트도 함께 보존했다.

## 검증

추적 파일만 `git archive`로 푼 별도 체크아웃에서 실행했다. 작업 폴더에 남아 있는 과거 원시 자료의 테스트가 제품 테스트 수에 섞이지 않았다.

| 명령 | 최종 결과 |
| --- | --- |
| `claude plugin test .` | 333 pass, 0 fail |
| `python3 -m unittest discover -s experiments/long-task -p 'test_*.py' -v` | 98/98 PASS |
| `PYTHONPATH=experiments/long-task python3 -m unittest discover -s experiments/long-task/runs/pilot-20261027-repair -p 'test_*.py' -v` | 20/20 PASS |
| `claude plugin validate . --json` | success=true; 기존 디렉터리 아이콘 경고는 비차단 |
| 개인·이전 판정 기록 대체 읽기 허용 변이 | 검사 실패, exit 1 — 결함 거부 확인 |
| `git diff --cached --check origin/main` | PASS |

병합 직후 첫 검사에는 플러그인 3건 실패와 Python 모듈 경로 ImportError가 있었다. 이어진 검사에서 2건이 남아, 테스트 스텁의 API 대화와 명령 실행 경로까지 수정했다. 위 표는 그 뒤 최종 성공한 검사다. 초기 실패를 성공한 것으로 합산하지 않았다. 소스 대응과 명령별 수치는 [publication-checks-20261030.json](../../experiments/long-task/publication-checks-20261030.json)에 있다.

## 공개 자료 범위

코드·테스트·보고서·참조된 완료/사용량 영수증·분석 코드와 집계·당시 소스 복사본을 포함했다. 약 2GB의 원시 요청·응답, 작업 폴더와 연구 장부는 기존 runs/ 제외 규칙에 따라 로컬에 보존한다. 공개 매니페스트는 원본의 경로·해시를 기록하며, 공개 영수증만으로 전체 실험을 새로 검증했다고 보지 않는다. .omc 런타임 상태와 .env는 공개하지 않는다.

생성 모델·Jev를 부르는 재실험, 전체 36회 연구, 배포·플러그인 재설치는 실행하지 않았다. 이 커밋·병합은 두 기기에서 제거한 설치를 되돌리지 않는다.
