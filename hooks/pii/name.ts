// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/personal/name.py), with modifications:
// the min_confidence option is left out (the rule set runs with its default, 0), and so is
// has_name_candidate, which only served the local LLM detector.

// Names: a common surname followed by one or two syllables, taken only with a cue: a role word
// before ("고객", "환자", "작성자") or an honorific or title after ("님", "씨", "대리"). Both cues
// give 0.75, one gives 0.5. Form labels with a colon ("성명: 류서윤"), table columns under a name
// header, slash-separated records and lists after a cued name are found as well.
// A known trade-off: a cue word near an ordinary word ("고객 이용 안내") can make a false name.

import type { Detection } from './overlaps'
import { end as endOf, isSpace, Re, rstrip, span, splitLines, start as startOf, startsWithAny, strip, type Match } from './regex'

// Common surnames, two-syllable ones first so "선우예진" is 선우 + 예진.
const SURNAMES = [
  '남궁', '선우', '제갈', '황보', '독고', '서문', '사공',
  '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
  '한', '오', '서', '신', '권', '황', '안', '송', '전', '홍',
  '유', '고', '문', '양', '손', '배', '백', '허', '남', '심',
  '노', '하', '곽', '성', '차', '주', '우', '구', '민', '나',
  '진', '지', '엄', '채', '원', '천', '방', '공', '현', '함',
]

// Titles after a name (#213, #394). Those added in #603 are kept apart (CUES_603); the court
// titles 판사, 검사, 증인 (#663) are taken only before a name (COURT_PREFIX_TITLES).
const TITLE_CUES_603 = ['책임', '선임', '수석', '박사', '여사', '어르신', '피고', '원고', '프로', '기사', '선수', '판사', '검사', '증인']
const TITLE_CUES = [
  '팀장', '과장', '부장', '차장', '대리', '사원', '실장', '본부장',
  '이사', '대표', '원장', '교수', '주임', '반장', '사장', '회장', '님',
  '총무', '매니저', '상무', '전무', '국장', '처장', '계장', '소장', '지점장', '지사장',
  '부사장', '부원장', '부팀장', '센터장', '사무장', '이사장', '위원장', '위원', '주무관',
  '간호사', '변호사', '회계사', '세무사', '약사', '의사', '교사', '강사', '상담사',
  '상담원', // #580
  '연구원', '조교', '기자', '코치', '감독', '인턴', '팀원',
  ...TITLE_CUES_603,
]

// Role words before a name, followed by a space or colon. #603 added order, legal and approval roles.
const PREFIX_CUES_603 = [
  '주문자', '구매자', '예약자', '투숙객', '받는 분', '받는사람', '보내는 사람',
  '피고인', '채무자', '피해자', '신고인', '세대주', '배우자', '소유자', '운전자',
  '검토자', '승인자', '기안자',
  '받는 사람', // #663
  '원고들', '피고들', '피고인들', '피해자들', // plural court roles (#685)
]
const PREFIX_CUES = [
  '고객', '환자', '신청자', '작성자', '담당자', '수령인', '수신인', '성명', '이름', '저는',
  '환자명', '고객명', '회원명', '성함', '실명',
  '명의자', '예금주', '입금자', '송금인', '수취인', '발신인', '발송인',
  '서명자', '대상자', '채용자', '지원자', '가입자', '신청인', '청구인', '계약자',
  '피보험자', '보호자', '대리인', '의뢰인', '내담자', '민원인',
  '학생', '응시자', '참석자', '참가자', '면접자', '근로자', '임차인', '임대인',
  ...PREFIX_CUES_603,
]

// Honorifics and roles after a name, glued ("님께") or spaced ("환자분").
const SUFFIX_CUES = ['선생님', '고객님', '환자분', '님', '씨', '군', '양', '담당자', '작성자', '신청자', '수령인', '수신인', '학생', '환자', '회원', '보호자']

// Label words that start with a surname, filtered by prefix: no real name starts with them.
// "이사" stops "대표 이사가" (#239).
const NON_NAME_WORDS = ['전화번호', '이메일', '주민등록번호', '주민번호', '주민등록증', '주소', '나이', '성별', '생년월일', '이사', '성명', '성함', '이름', '이력']

// Common two-syllable nouns that start with a surname ("고객 문의", "대표 차량이"), filtered
// only where the word ends; "정기훈", "이용재" go on as names (#247, #255, #484).
const COMMON_WORDS = new Set([
  '구매', '정기', '홍보', '안전', '노무', '차량', '허가', '성과', '안내',
  '이용', '이유', '서류', '서명', '정보', '문의', '문서', '문자', '문제', '양식', '양성',
  '조사', '조건', '조정', '조회', '지원', '지급', '지정', '진행', '신규', '신청',
  '채용', '공지', '공사', '공고', '구성', '구역', '방문', '방침', '배송', '배정',
  '유지', '유통', '임대', '임시', '원본', '원가', '현장', '현황', '하자', '오류',
  '백업', '강의', '강화', '정산', '정책', '장비', '장소', '전달', '전체', '전자', '전화',
  '전송', '주차', '주문', '주간', '민원', '고객', '박스',
  '최근', '최고', '최종', '최대', '최소', '이전', '이후', '이상', '이내', '이하', '이번',
  '오전', '오후', '한국', '서울',
  '정밀', '문맥', '전혀', '공식',
])

// Nouns common after the #603 cues, filtered only when every cue is one of those.
const CUES_603 = new Set([...TITLE_CUES_603, ...PREFIX_CUES_603])
const CUE_603_COMMON_WORDS = new Set(['진술', '진술서', '공제', '안내문', '우대', '오늘자'])
const COURT_PREFIX_TITLES = new Set(['판사', '검사', '증인'])
// Plural court roles (#685) get the court titles' condition: another word after is no name.
const PLURAL_ROLE_PREFIXES = new Set(['원고들', '피고들', '피고인들', '피해자들'])
const COURT_CUE_COMMON_WORDS = new Set([
  '진술', '진술서', '진단서', '성적서', '신청서', '임명장', '정확도', '정밀도', '진행', '진행중',
  '신문', '전원', '정원', '신분', '방법', '조서', '심문', '결과',
])

// Titles without the honorific 님. With only such a cue the name must be surname + two (#213, #239).
// Two-syllable names are taken in the three places twoCharTitleNameOk allows (#601).
const TITLE_ONLY_CUES = new Set(TITLE_CUES.filter(c => !SUFFIX_CUES.includes(c)))
// Two-syllable words not taken as names there (#601): words qualifying a title ("신입 사원",
// "우리 팀장님") and placeholders in a title field ("대표: 공석"). Exact match; not complete.
const TITLE_CONTEXT_WORDS = new Set([
  '우리', '신입', '신임', '신인', '전임', '전담', '전문', '전략', '전산', '전직', '전교', '전국', '전속',
  '전공', '차기', '차석', '공동', '공인', '공익', '공석', '지도', '지역', '지점', '정규', '정식', '정치',
  '정부', '우수', '주무', '주민', '주요', '주전', '고문', '하계', '현역', '현직', '심사', '심의', '민간',
  '노조', '구조', '방송', '신문', '유망', '문화', '조직', '임원', '원로', '남자', '남녀',
  '지금', '오늘', '현재', '당시', '전날', '주말', '방학', '정말', '진짜', '원래', '이미', '이제', '우선',
  '한번', '하튼', '전부', '지난', '오신', '오실',
  '이라', '이고', '이다',
  '허위', '지휘', '주주', '노사', '유족', '정당', '현지', '원청', '조합', '진료', '원무', '한방', '심리', '진로',
  '임상', '주방', '고교', '공립', '유명', '구청', '공장', '장기', '현업', '공대', '고대', '이대', '홍대', '성대',
  '채택', '임용', '구인', '주기', '성적',
  '방금', '주로', '이건', '이런', '나도', '한편', '정작', '오직', '남은',
  '공란', '하단',
])
// A second syllable that is a particle or ending makes surname-syllable + particle ("전에 팀장에게", #601).
const TWO_CHAR_PARTICLE_TAILS = new Set('에는를을과와의면며엔')
// Titles not taken after a two-syllable name (#601): heads of places ("강남 지점장") and words
// more often meant otherwise (의사 "intent", 이사 "moving", 전무 "none", 감독 "supervision").
const TWO_CHAR_SKIP_TITLES = new Set([
  '의사', '이사', '전무', '감독',
  '지점장', '지사장', '본부장', '센터장', '소장', '원장', '부원장', '이사장', '위원장', '국장', '처장', '사무장',
])
// A three-syllable "name" ending in a two-syllable title is surname + title ("김부장", #677).
const TITLE_TAIL_WORDS = new Set(TITLE_CUES.filter(c => c.length === 2))

// Single-syllable particles after a name (#247, #484).
const JOSA_CHARS = new Set('이가은는을를도만의에로과와엔랑께')
// What may follow a title after a name (#601): a particle, honorific or ending's first syllable.
// Other Hangul makes the title part of a longer word ("노동 위원회", "서울 대리점").
const TITLE_FOLLOW_CHARS = new Set([...JOSA_CHARS, ...'님입으한하처부까보예였라조마밖'])
// 이 after a title ends it only as a particle or copula ("팀장이다"); not "교수이론", "대표이사".
const TITLE_I_ENDING_NEXT = new Set('다었며고라야에지나면랑여자시셨세신므니든래요란냐죠')
// Punctuation that closes a two-syllable name after a court title (#601); digits and letters do not.
const CLOSING_PUNCT = new Set('(),.;:!?/·[]「」『』"\'')

const byLengthDesc = (words: Iterable<string>): string[] => [...words].sort((a, b) => b.length - a.length)
const unique = (words: Iterable<string>): string[] => [...new Set(words)]
const sortedSet = (words: Iterable<string>): string[] => [...words].sort()

const SURNAME_ALT = byLengthDesc(SURNAMES).join('|')
// Cues before a name: role words and titles ("대표 홍길동", #239).
const PREFIX_ALT = byLengthDesc(unique([...PREFIX_CUES, ...sortedSet(TITLE_ONLY_CUES)])).join('|')
// 양 and 군 are also common last syllables and word starts ("양쪽", "군것질"): honorifics only
// at a word end, one particle allowed (#484). Short titles that start words ("프로젝트") likewise (#603).
const AMBIGUOUS_SUFFIX_TITLES = new Set(['양', '군'])
const BOUNDED_SUFFIX_TITLES = new Set(['프로', '기사', '선수'])
const JOSA_CHARS_STR = sortedSet(JOSA_CHARS).join('')
const SUFFIX_ALT_PLAIN = byLengthDesc(
  unique([...SUFFIX_CUES, ...TITLE_CUES].filter(c => !AMBIGUOUS_SUFFIX_TITLES.has(c) && !BOUNDED_SUFFIX_TITLES.has(c) && !COURT_PREFIX_TITLES.has(c))),
).join('|')
const AMBIGUOUS_SUFFIX_ALT = byLengthDesc(AMBIGUOUS_SUFFIX_TITLES).join('|')
const BOUNDED_SUFFIX_ALT = byLengthDesc(BOUNDED_SUFFIX_TITLES).join('|')
// Letter closings ("김영수 귀하", "홍길동 드림") at a line end or before punctuation; "배상" only
// after a three-syllable name (checked in scanCued).
const CLOSING_SUFFIX_ALT = '(?:귀하|드림|올림|배상)(?=[ \\t]*(?:\\r?\\n|$|[.,!?)\\]]))'
const SUFFIX_ALT =
  SUFFIX_ALT_PLAIN +
  '|(?:' +
  AMBIGUOUS_SUFFIX_ALT +
  ')(?=[' +
  JOSA_CHARS_STR +
  ']?(?![가-힣]))' +
  '|(?:' +
  BOUNDED_SUFFIX_ALT +
  ')(?=(?:님|씨)?(?:께서|께|[' +
  JOSA_CHARS_STR +
  '])?(?![가-힣]))' +
  '|' +
  CLOSING_SUFFIX_ALT

// A cue in parentheses right after the name (#604): "김민수(대리)", "김민수(35세, 남)", "김민수(인)",
// "김민수 (010-...)". Age only, sex only or contact details need a three-syllable name (see scanCued).
const PAREN_CUE_END = '(?=[ \\t]*[),·/])'
const PAREN_TITLE_TAIL = '(?:님)?' + PAREN_CUE_END
const PAREN_PERSON =
  '(?:(?:(?:남|여)(?:성|자)?[ \\t]?[,/·][ \\t]?)?(?:만[ \\t]?)?\\d{1,3}[ \\t]?세' + '|인|서명(?:[ \\t]?또는[ \\t]?(?:날)?인)?|직인|날인|사인)' + PAREN_CUE_END
const PAREN_SEX = '(?:남|여)(?:성|자)?' + PAREN_CUE_END
const PAREN_LONG_ONLY = '\\d{1,3}' + PAREN_CUE_END + '|0\\d{1,2}[-.\\s]?\\d{3,4}[-.\\s]?\\d{4}|\\+82|[A-Za-z0-9._%+-]+@'
// Words common where a parenthesis is the only cue ("정정(인)", "문의처 (02-...)", #604).
const PAREN_COMMON_WORDS = new Set(['구분', '정정', '남녀', '임원', '주의', '유의', '방법', '우편', '정답', '공정', '김치', '하단', '문의처'])

// Not taken as a name's second syllable (#147): 님 and 씨 belong to the suffix, and 입 는 을 를 과
// 와 에 께 do not end names. 군 and 양 do (#340), so they stay.
const NAME_TAIL_STOP = '님씨입는을를과와에께'

// Endings after which the name has ended, whatever follows (#600): the copula ("김민수예요"),
// honorific forms ("이신가요"), and two-syllable particles followed by more ("에게는").
const OPEN_ENDING_STEMS = [
  '입니다', '이에요', '예요', '이었', '였', '이라', '라고', '라는', '라서', '라면', '란',
  '이신', '이세', '이시', '이십', '인데', '인가', '인지', '이야', '이죠', '이지', '이네',
  '이나', '이든', '이면', '에게', '에서', '께서', '한테', '까지', '부터', '처럼', '보다',
  '마저', '조차', '밖에', '뿐',
  '이고요', // #663
]
const OPEN_ENDING_ALT = byLengthDesc(OPEN_ENDING_STEMS).join('|')
// The name ends as before #600 (closed list plus word end).
const PRE600_NAME_END_RE = new Re(
  '(?:입니다|이며|이고|에게서|에게|에서|한테|께서|이랑|하고|처럼|부터|까지|보다|으로|로서' + '|[' + JOSA_CHARS_STR + ']{1,2}(?:님|씨)?)?(?![가-힣])',
)

// 을 is also a last syllable ("김가을", #579): it stays in the name when an honorific, a
// particle or an ending follows (#600).
const EUL_AS_LAST_SYLLABLE = '을(?=\\s?(?:' + SUFFIX_ALT_PLAIN + ')|[이가은는의에도만로와과랑께]|(?:' + OPEN_ENDING_ALT + '))'

// Between label and name: colon and spaces (two), three horizontal spaces, " : " and " | " (#491).
const LABEL_SEP = '(?:[:\\s]{1,2}|[ \\t]{1,3}|[ \\t]{0,3}[:|][ \\t]{0,3})'
// #603 titles that start like real names ("원고은", "박사랑").
const NAME_LIKE_TITLES_603 = TITLE_CUES_603.filter(t => startsWithAny(t, SURNAMES))
const NAME_LIKE_603_SET = new Set(NAME_LIKE_TITLES_603)

// Form labels for names alone: with a colon or bar after, names outside the surname list count (#491, #537).
// "담당" too (#685): without a colon "담당 부서" is an ordinary phrase.
const FORM_LABELS_603 = ['작성', '서명', '발신', '수신', '참조', '결재', '담당']
const FORM_LABELS = [
  '성명', '이름', '성함', '실명', '예금주', '명의자', '환자명', '고객명', '회원명',
  '수취인', '송금인', '입금자', '신청인', '신청자', '보호자', '대표자',
  '이력서 접수', '면허 갱신 신청',
  ...FORM_LABELS_603,
]
const FORM_LABEL_SET = new Set(FORM_LABELS)
const FORM_LABEL_603_SET = new Set(FORM_LABELS_603)
// Spaced labels: a value starting with one is the next label (#674).
const MULTIWORD_FORM_LABELS = FORM_LABELS.filter(label => label.includes(' '))
// Table headers: rows under a name label; the short #603 labels only when no such row exists (#674).
const TABLE_NAME_HEADERS = new Set(FORM_LABELS.filter(l => !FORM_LABEL_603_SET.has(l)))
// "담당" is neither a header nor a name column (#685): its column holds parts and departments.
const TABLE_WEAK_NAME_HEADERS = new Set(FORM_LABELS_603.filter(l => l !== '담당'))
const TABLE_NAME_COLUMN_LABELS = new Set(FORM_LABELS.filter(l => l !== '담당'))

// "이름" is too general to waive the common-word filter (#484); the narrow form labels do.
const STRONG_LABEL_PREFIXES = new Set(FORM_LABELS.filter(l => l !== '이름'))
// A three-syllable name before a two-syllable #603 title ending in a particle is word + particle (#603).
const TWO_CHAR_TITLE_JOSA_END_RE = new Re('^[가-힣]{2}[의가는를와과]$')
// Sender, recipient and cc fields hold departments more often (#603).
const ORG_VALUE_LABELS = new Set(['발신', '수신', '참조', '담당'])
const ORG_VALUE_END_RE = new Re('(?:팀|실|부|과|국|처|청)$')
// Departments and duties common in a "담당:" field (#685), filtered under that label only.
const DUTY_LABEL_NOT_NAMES = new Set([
  '영업', '인사', '기획', '개발', '마케팅', '재무', '회계', '법무', '생산', '품질', '물류', '연구', '디자인',
  '운영', '관리', '전산', '보안', '총무', '홍보', '구매', '고객지원', '경영지원', '영업지원',
  '정리', '공통', '공유', '조율',
])
// Approval states (#603); not names, but a list after them goes on (#674).
const FORM_NOT_NAMES_603 = new Set(['완료', '요청', '대기', '전체', '관련', '본사', '접수', '진행', '반려', '보류'])
// Values put in a form field instead of a name, and common column names; exact match only (#491).
const FORM_NOT_NAMES = new Set([
  '없음', '미기재', '미상', '본인', '해당없음', '비공개', '생략', '미정', '기재', '공란', '빈칸',
  '상동', '동일', '별첨', '참조', '하단', '상단', '아래', '모름', '익명', '불명', '무기명', '공석',
  '필수', '선택', '확인', '작성', '기입', '입력', '한글', '영문', '자필', '서명', '날인', '직인',
  '설명', '소속', '직위', '직책', '연락처', '부서', '역할', '비고', '상태', '형식', '경로', '기본값',
  '버전', '관계', '은행', '학번', '타입', '번호', '주소', '전화', '날짜', '금액', '수량', '내용',
  '항목', '구분', '법인', '개인', '회사명', '팀명', '부모', '모친', '부친', '배우자', '대리인',
  ...FORM_NOT_NAMES_603,
])
// 은 이 가 도 also end names ("기재은"), so they are not stripped.
const FORM_VALUE_ENDING_RE = new Re('(?:입니다|이며|이고|님|씨|[는을를의와과])$')

// Table separators; the comma first (#526). The slash splits staff lists ("이름 / 부서", #581).
const TABLE_SEPS = [',', '\t', '|', '/']

// A table value shaped like a name: 2-4 Hangul syllables, not starting with 님 or 씨 (#526).
const TABLE_NAME_VALUE_RE = new Re('(?:(?![님씨])[가-힣]){2,4}')

// A headerless slash record ("김민수 / 개발팀 / 010-...", #581): the first of three or more cells
// a 3-4 syllable name, another cell a phone number, an email or a birth date.
const SLASH_RECORD_LEAD_RE = new Re('[ \\t]*(?:[-*•·]|\\d{1,3}[.)])?[ \\t]*')
const SLASH_RECORD_MIN_CELLS = 3
const SLASH_RECORD_MIN_NAME_LEN = 3
const SLASH_RECORD_DETAIL_RE = new Re('@|0\\d{1,2}[-.\\s]?\\d{3,4}[-.\\s]?\\d{4}|생년월일|생일')

// Another word after the name, spaced (#663).
const WORD_CONTINUES_RE = new Re('[ \\t]+[가-힣]')
// "원고가", "박사가" after a court title is the next name's cue (#663).
const NAME_LIKE_TITLE_JOSA_RE = new Re('(?:' + NAME_LIKE_TITLES_603.join('|') + ')[은는이가]')

// A Markdown separator cell ("|---|:--:|").
const TABLE_SEPARATOR_CELL_RE = new Re('[-:\\s]*')
const FORM_NAME_RE = new Re(
  // Hangul before the label makes another word ("파일이름: 보고서").
  '(?<![가-힣])(?P<label>' +
    byLengthDesc(FORM_LABELS).join('|') +
    ')' +
    // A parenthesised note ("성명(한글)"), then colon or bar, horizontal spaces only.
    '(?:\\([^()\\r\\n]{1,12}\\))?[ \\t]{0,3}[:|][ \\t]{0,3}' +
    '(?<![가-힣])(?P<name>(?:(?![님씨])[가-힣]){2,4})' +
    '(?=(?:' +
    OPEN_ENDING_ALT +
    ')|(?:입니다|이며|이고|님|씨|[은는이가을를의와과도])?(?![가-힣]))',
  { indices: true },
)

// A role word or title, with a particle allowed ("담당자는 홍길동"), then the separator, kept as
// a group: a colon or bar makes the cue strong (#484, #491).
const NAME_PREFIX_PART = '(?:(?P<prefix>' + PREFIX_ALT + ')(?:은|는|이|가)?(?P<label_sep>' + LABEL_SEP + '))?'
// Python ends the body with the conditional (?(suffix)|(?(paren)|(?=END))): without a suffix or
// a parenthesis after, the name must end its word (#484, #600). JavaScript has no conditional
// groups, so the optional cue group gets END as its third alternative, tried in the same order.
const NAME_END =
  '(?=(?:' +
  OPEN_ENDING_ALT +
  ')|(?:입니다|이며|이고|에게서|에게|에서|한테|께서' +
  '|이랑|하고|처럼|부터|까지|보다|으로|로서|야|[' +
  JOSA_CHARS_STR +
  ']{1,2}(?:님|씨)?)?' +
  '(?![가-힣]))'
const NAME_BODY =
  // The surname starts a word (#158).
  '(?<![가-힣])' +
  '(?P<name>(?:' +
  SURNAME_ALT +
  ')[가-힣]' +
  '(?:(?![' +
  NAME_TAIL_STOP +
  '])[가-힣]|' +
  EUL_AS_LAST_SYLLABLE +
  ')?)' +
  '(?:\\s?(?P<suffix>' +
  SUFFIX_ALT +
  ')' +
  '|(?P<paren>[ \\t]?)(?=\\([ \\t]*(?:(?P<paren_title>' +
  SUFFIX_ALT_PLAIN +
  ')' +
  PAREN_TITLE_TAIL +
  '|' +
  PAREN_PERSON +
  '|(?P<paren_sex>' +
  PAREN_SEX +
  ')' +
  '|(?P<paren_long>' +
  PAREN_LONG_ONLY +
  ')))' +
  '|' +
  NAME_END +
  ')'
const NAME_RE = new Re(NAME_PREFIX_PART + NAME_BODY, { indices: true })
// The same place read without a cue before; prefix and label_sep never take part (#674).
const NAME_NO_PREFIX_RE = new Re('(?:(?P<prefix>(?!))(?P<label_sep>(?!)))?' + NAME_BODY, { indices: true })
// Line breaks the one space before a suffix can cross (#662).
const LINE_BREAK_RE = new Re('[\n\r\x0b\x0c\x85\u2028\u2029]')

// A list after a cued name ("참석자: 김민수, 이서연, 박지훈", #602) inherits the cue. Honorifics on
// the previous name are skipped; separators are punctuation, "와 과 랑 이랑 하고" glued, "및 그리고
// 또는" spaced. "박사랑" is a name, not 박사 + 랑 (#674).
const LIST_SUFFIX = '(?:[ \\t]?(?!(?:' + NAME_LIKE_TITLES_603.join('|') + ')랑[ \\t])(?:' + SUFFIX_ALT + '))?'
const LIST_GAP_RE = new Re(LIST_SUFFIX + '(?:[ \\t]*[,，、·ㆍ・･•/][ \\t]*|(?:와|과|이랑|랑|하고)[ \\t]+|[ \\t]+(?:및|그리고|또는)[ \\t]+)')
// A punctuation separator ends a cell; joining words only carry on to the next one.
const LIST_PUNCT_GAP_RE = new Re(LIST_SUFFIX + '[ \\t]*[,，、·ㆍ\u30fb\uff65\u2022/]')
// Lists separated by spaces alone only after a colon or bar label, three-syllable cells only.
const LIST_SPACE_GAP_RE = new Re(LIST_SUFFIX + '[ \\t]+')
// A list cell's name: the name and end conditions of NAME_RE, an honorific or title allowed after.
const LIST_NAME_RE = new Re(
  '(?<![가-힣])(?P<name>(?:' +
    SURNAME_ALT +
    ')[가-힣]' +
    '(?:(?![' +
    NAME_TAIL_STOP +
    '])[가-힣]|' +
    EUL_AS_LAST_SYLLABLE +
    ')?)' +
    '(?=[ \\t]?(?:' +
    SUFFIX_ALT +
    ')|(?:' +
    OPEN_ENDING_ALT +
    ')|(?:입니다|이며|이고|에게서|에게|에서' +
    '|한테|께서|이랑|하고|처럼|부터|까지|보다|으로|로서|야|[' +
    JOSA_CHARS_STR +
    ']{1,2}(?:님|씨)?)?' +
    '(?![가-힣]))',
  { indices: true },
)
const LIST_SPACE_NAME_LEN = 3
// Relations, sexes and states in list cells that look like names (#602); exact match only.
const LIST_NOT_NAMES = new Set([
  '남편', '아내', '장남', '장녀', '차남', '차녀', '손자', '손녀', '조카', '지인', '오빠', '언니', '누나',
  '형님', '동생', '이웃', '모친', '부친', '자녀', '아들', '남성', '여성', '남자', '여자',
  '정상', '양호', '고열', '지각', '조퇴', '신입', '전세', '월세', '전결', '정규직', '임시직',
  '주부', '한국인', '외국인', '우수', '최우수', '전원', '정리', '신협', '우체국',
  '장학생', '전학생', '재학생', '휴학생',
])
// Last syllables of departments, places and descriptions, never of names ("홍보팀", "강의실").
const LIST_NOT_NAME_LAST = new Set('팀실함됨적')
// A two-syllable cell glued to a title is department + title ("홍보팀장").
const TITLE_ONLY_PREFIXES = byLengthDesc(TITLE_ONLY_CUES)
// How a list cell may end: an honorific or title, the next separator, a common particle or
// ending, a line or sentence end, a closing form (#537, #602).
const LIST_TAIL_SUFFIX_RE = new Re('[ \\t]?(?:' + SUFFIX_ALT + ')')
const LIST_TAIL_JOSA_RE = new Re('(?:입니다|이며|이고|에게|께서|한테|이었|였|이라|이다|[이가은는도께만](?![가-힣]))')
const LIST_TAIL_PUNCT = new Set('.)]」』>!?;|"\'…*#')
// Closing the last cell: 등 외 총 이상 귀하 at a word end, the stems 참석 불참 드림 올림, a head count,
// a parenthesis, trailing spaces, a spaced dash, a closing mark after a space. Not a colon.
const LIST_CLOSING_RE = new Re(
  '[ \\t]+(?:(?:등|외|총|이상|귀하)(?![가-힣])|참석|불참|드림|올림)' +
    '|[ \\t]+\\d+[ \\t]?(?:명|인)|[ \\t]*\\(|[ \\t]+(?=\\r?\\n|$)|[ \\t]+[-–—][ \\t]' +
    '|[ \\t]+[|\\"\'…*#.)\\]」』>!?;]',
)

// A name's shape (surname + one or two syllables), as in NAME_RE and LIST_NAME_RE.
const NAME_SHAPE = '(?:' + SURNAME_ALT + ')[가-힣]' + '(?:(?![' + NAME_TAIL_STOP + '])[가-힣]|' + EUL_AS_LAST_SYLLABLE + ')?'
const NAME_SHAPE_RE = new Re(NAME_SHAPE)
// The #685 head counts, reversed lists and "담당:" values take three syllables or more.
const FOLLOWUP_MIN_NAME_LEN = 3
// "외 N명", "등 N명" after a name (#685): "피고 ○○○ 외 2명", "김민수 등 3명".
const COUNT_AFTER =
  '[ \\t]*(?:외|등)[ \\t]*(?:\\d{1,4}|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|여러)[ \\t]*(?:명|인)' +
  '(?:이|은|을|의|과|와|도|만|까지|께|에게|에게는|에게도|에|에는|으로|으로는|뿐|뿐이다|이다|이며|이고|입니다)?(?![가-힣])'
const COUNT_AFTER_RE = new Re(COUNT_AFTER)
const COUNT_TAIL_RE = new Re('(?<![가-힣])(?P<name>' + NAME_SHAPE + ')' + COUNT_AFTER, { indices: true })
// Group nouns before "외 N명" shaped like names ("임직원 외 30명", #685). Exact match; not complete.
const COUNT_TAIL_NOT_NAMES = new Set([
  '우리', '이들', '정원', '인원', '전원', '본인', '일행', '주민', '신자',
  '임직원', '조합원', '공무원', '장애인', '이용자', '고령자', '구직자', '노동자', '유권자', '유가족', '전문가',
  '유학생', '지지자', '공직자', '정치인', '임원진', '이사진', '구성원', '정회원', '방문자', '신고자', '성직자',
])
// Last syllables common in group nouns, rare in names ("조문객", "대표단", "주민들").
const COUNT_TAIL_NOT_LAST = new Set('객족단들생병')
// A messenger export's "[박지훈] [오후 3:01]" at a line start (#685): the time bracket is the cue.
// (?<![^\n]) is Python's MULTILINE ^, which a JavaScript m flag would widen to other line breaks.
const BRACKET_NAME_RE = new Re('(?<![^\\n])[ \\t]*\\[(?P<name>' + NAME_SHAPE + ')\\][ \\t]*\\[(?:오전|오후|AM|PM|am|pm)?[ \\t]*\\d{1,2}:\\d{2}\\]', {
  indices: true,
})
// Separators of names sharing the last one's cue ("김민수, 이서연 님께", #685).
const REVERSE_LIST_SEPS = new Set(',，、·ㆍ・･•')

// A name's shape, shortest first: "조정이고요" is 조정 + 이고요 (#663, #589).
const NAME_SHAPE_LAZY = '(?:' + SURNAME_ALT + ')[가-힣]' + '(?:(?![' + NAME_TAIL_STOP + '])[가-힣]|' + EUL_AS_LAST_SYLLABLE + ')??'
// A self-introduction after a greeting or "저는" (#663): "안녕하세요. 구매팀 백군원입니다". The greeting
// keeps out "검사 결과 정상입니다"; up to four words before the department, one role word after it.
const GREETING = '(?:안녕하세요|안녕하십니까|수고하십니다|수고[ \\t]?많으십니다|반갑습니다|인사드립니다|여보세요|감사합니다|고맙습니다)'
const SELF_INTRO_RE = new Re(
  '(?:' +
    GREETING +
    '[.!,~]*[ \\t]*(?:\\r?\\n[ \\t]*){0,2}|(?<![가-힣])저는[ \\t]+)' +
    '(?:[가-힣A-Za-z0-9()]{1,12}[ \\t]+){0,4}' +
    '(?P<org>[가-힣A-Za-z0-9]{1,10}(?:팀|센터|본부|부서|파트|그룹|지점|지사|사무소|연구소)|[가-힣]{2,10}(?:부|과|실))' +
    '(?:의)?[ \\t]+(?:(?:담당|파트장|리더|총괄|간사)[ \\t]+)?(?P<name>' +
    NAME_SHAPE_LAZY +
    ')' +
    '[ \\t]?(?:입니다만|입니다|이에요|예요|이고요|인데요|이라고|라고)(?![가-힣])',
  { indices: true },
)
// Three-syllable candidates ending so are documents and events ("공지문입니다", "송년회입니다").
const SELF_INTRO_NOT_NAME_LAST = new Set('문표회록집함')
const COMPOUND_SURNAMES = new Set(SURNAMES.filter(s => s.length === 2))
// Endings of words in the department's place that are no department ("검사결과", "회의실").
const SELF_INTRO_NOT_ORG_ENDS = [
  '결과', '효과', '성과', '사실', '현실', '진실', '확실', '전부', '일부', '내부', '외부', '세부',
  '화장실', '회의실', '휴게실', '강의실', '탈의실', '응급실', '수술실', '대기실', '자료실', '전시실',
]
// Work words after a department that start with a surname ("개발팀 서버입니다"). Not complete.
const SELF_INTRO_NOT_NAMES = new Set([
  '서버', '서비스', '서식', '안내문', '안내서', '안건', '공문', '공유', '공용', '공개', '공간', '정리', '정식', '전담',
  '전산', '주관', '주최', '지침', '지시', '신고', '신설', '원칙', '유의', '진단', '하청', '방안', '담당',
  '공문서', '신청서', '정산서', '조직도', '구성도', '구조도',
])
// "제 이름은 황재고요" (#663): right after "제 이름은", 고요 and common-word names count.
const MY_NAME_IS_RE = new Re(
  '(?<![가-힣])(?:제|저의|내)[ \\t]*이름은[ \\t]+(?P<name>' + NAME_SHAPE_LAZY + ')(?:입니다|이에요|예요|이고요|고요|이라고요|라고요|이라고|라고|이야)(?![가-힣])',
  { indices: true },
)
// The second name of "김민수에서 이서연으로 변경" (#589), matched only at a found name's end.
const CHANGE_LOG_NEXT_RE = new Re(
  '에서(?:[ \\t]+|[ \\t]*\\r?\\n[ \\t]*)(?P<name>' +
    NAME_SHAPE_LAZY +
    ')(?:으로|로)[ \\t]*(?:(?:최종|다시|새로|모두)[ \\t]*)?(?:변경|교체|바뀌|바뀐|바꾸|바꿨|바꿔|대체|교대|인계)',
  { indices: true },
)

// All cues (role words, honorifics, titles). A candidate equal to one is no name (#450).
const ALL_CUES = unique([...PREFIX_CUES, ...SUFFIX_CUES, ...TITLE_CUES])
const CUE_WORDS = new Set(ALL_CUES)

// A list cell equal to one of these ends the list; the #603 ones do not (#674).
const LIST_STOP_CUE_WORDS = new Set(ALL_CUES.filter(c => !CUES_603.has(c)))
const LIST_STOP_FORM_VALUES = new Set([...FORM_NOT_NAMES].filter(v => !FORM_NOT_NAMES_603.has(v)))

// Repeated names (#608): word starts only.
const HANGUL_RUN_RE = new Re('[가-힣]+')
// Never spread, so one false name does not spread through the text.
const REPEAT_NOT_SEEDS = new Set([
  ...COMMON_WORDS, ...TITLE_CONTEXT_WORDS, ...COUNT_TAIL_NOT_NAMES, ...COURT_CUE_COMMON_WORDS,
  ...SELF_INTRO_NOT_NAMES, ...FORM_NOT_NAMES, ...CUE_WORDS,
])
// A one-cue name spreads when a role word precedes it and one of these follows ("담당자 김민수입니다").
const REPEAT_SEED_ENDINGS = ['입니다', '이에요', '예요']
const REPEAT_ROLE_CUES = byLengthDesc(new Set(PREFIX_CUES.filter(c => c !== '저는' && c !== '이름')))
// Form labels for names alone whose values spread; not the short #603 labels nor "이름".
const REPEAT_SEED_FORM_LABELS = new Set(FORM_LABELS.filter(l => !FORM_LABEL_603_SET.has(l) && l !== '이름'))

// A role word or title with a particle ("원장이", "차장은") is the next name's cue (#491, #533);
// the #603 titles that start like names are left out (#674).
const CUE_WITH_JOSA_ALT = byLengthDesc(unique([...PREFIX_CUES, ...sortedSet([...TITLE_ONLY_CUES].filter(c => !NAME_LIKE_603_SET.has(c)))])).join('|')
const CUE_WITH_JOSA_RE = new Re('(?:' + CUE_WITH_JOSA_ALT + ')(?:은|는|이|가)')
// Form, table and list values use the pre-#603 cues only (#674).
const CUE_WITH_JOSA_OLD_RE = new Re(
  '(?:' +
    byLengthDesc(unique([...PREFIX_CUES.filter(c => !CUES_603.has(c)), ...sortedSet([...TITLE_ONLY_CUES].filter(c => !CUES_603.has(c)))])).join('|') +
    ')(?:은|는|이|가)',
)

const isHangul = (ch: string): boolean => ch >= '가' && ch <= '힣'

/** Whether text[pos:] can follow a name: the pre-#600 endings and word end, or an ending's start. */
const nameCouldEndAt = (text: string, pos: number): boolean => PRE600_NAME_END_RE.match(text, pos) !== null || startsWithAny(text, OPEN_ENDING_STEMS, pos)

/** Whether a common noun (three or two syllables) starts at pos and its word ends there (#247, #600). */
function isCommonWordAt(text: string, pos: number, words: ReadonlySet<string> = COMMON_WORDS): boolean {
  for (const n of [3, 2]) if (words.has(text.slice(pos, pos + n))) return commonWordEndsAt(text, pos, n)
  return false
}

function commonWordEndsAt(text: string, pos: number, n: number): boolean {
  const e = pos + n
  const after = text.slice(e, e + 1)
  if (!after || !isHangul(after)) return true
  if (startsWithAny(text, OPEN_ENDING_STEMS, e) && !PRE600_NAME_END_RE.match(text, e) && !nameCouldEndAt(text, e + 1)) return true
  if (JOSA_CHARS.has(after)) {
    const after2 = text.slice(e + 1, e + 2)
    return !after2 || !isHangul(after2)
  }
  return false
}

/**
 * Whether text[pos:] starts with a label or common word rather than a name. Labels always
 * count; common words not when the cue is strong (both cues, a narrow label, a colon): some are
 * also real names ("고객 이상 씨").
 */
function isLabelWordAt(text: string, pos: number, strong = false): boolean {
  if (startsWithAny(text, NON_NAME_WORDS, pos)) return true
  return !strong && isCommonWordAt(text, pos)
}

/** Whether a role word (REPEAT_ROLE_CUES) ends right before pos, spaces and colons skipped (#608). */
function roleCueBefore(text: string, pos: number): boolean {
  let k = pos
  while (k > 0 && ' \t:'.includes(text[k - 1]!)) k--
  const head = text.slice(0, k)
  return REPEAT_ROLE_CUES.some(cue => head.endsWith(cue) && (k === cue.length || !isHangul(text[k - cue.length - 1]!)))
}

/** Whether a title after a name ends at pos: text end, not Hangul, or a particle's or ending's start (#601). */
function titleEndsAt(text: string, pos: number): boolean {
  const ch = text.slice(pos, pos + 1)
  if (!ch || !isHangul(ch)) return true
  if (ch === '이') {
    const nxt = text.slice(pos + 1, pos + 2)
    return !nxt || !isHangul(nxt) || TITLE_I_ENDING_NEXT.has(nxt)
  }
  return TITLE_FOLLOW_CHARS.has(ch)
}

/** Whether a word is closed at pos: after horizontal spaces, text end, a line break or closing punctuation (#601). */
function closedAfter(text: string, pos: number): boolean {
  while (pos < text.length && isSpace(text[pos]!) && text[pos] !== '\r' && text[pos] !== '\n') pos++
  const ch = text.slice(pos, pos + 1)
  return !ch || ch === '\r' || ch === '\n' || CLOSING_PUNCT.has(ch)
}

/**
 * Whether a two-syllable candidate with a title as its only cue is a name (#601), in three places:
 * spaced before a title ("남원 팀장이"), after a title with a colon or bar ("상담원: 이영"), and
 * after 판사, 검사, 증인 when the name is closed ("판사 한하 (재판장)"). False keeps the old behaviour.
 */
function twoCharTitleNameOk(
  name: string,
  prefix: string | undefined,
  suffix: string | undefined,
  o: { explicitSep: boolean; glued: boolean; closed: boolean; common: boolean; titleEnds: boolean },
): boolean {
  if (o.common || TITLE_CONTEXT_WORDS.has(name) || LIST_NOT_NAMES.has(name) || TWO_CHAR_PARTICLE_TAILS.has(name[1]!)) return false
  if (prefix === undefined) return suffix !== undefined && !CUES_603.has(suffix) && !TWO_CHAR_SKIP_TITLES.has(suffix) && !o.glued && o.titleEnds
  return o.explicitSep || (COURT_PREFIX_TITLES.has(prefix) && o.closed)
}

type Seed = [number, boolean]

const make = (text: string, s: number, e: number, confidence: number): Detection => ({ kind: 'name', start: s, end: e, text: text.slice(s, e), confidence })

/** Marks the spans already found, for linear overlap checks. */
function coverage(length: number, found: readonly Detection[]): Uint8Array {
  const covered = new Uint8Array(length)
  for (const d of found) covered.fill(1, d.start, d.end)
  return covered
}
const allCovered = (covered: Uint8Array, s: number, e: number): boolean => covered.subarray(s, e).every(v => v === 1)

const group = (m: Match, name: string): string | undefined => m.groups![name]

/**
 * The cued scan. Returns (names, list seeds, whether a suffix was read across a line break).
 * With resumeLines it resumes at such a suffix (#662); without, it scans as before #662.
 */
function scanCued(text: string, resumeLines: boolean): [Detection[], Seed[], boolean] {
  const found: Detection[] = []
  // Where a cued name ended: the start of a list after it (#602)
  const listSeeds: Seed[] = []
  let pos = 0
  // Where a scan resumed at a suffix after dropping a common word after a #603 cue (#676)
  let resumeCue = -1
  // Where a scan resumes at a suffix across a line break, and where it would have gone on (#662)
  let lineResumeAt = -1
  let lineResumeEnd = -1
  let crossed = false
  // Searched one by one, not with finditer: a dropped candidate ("신청자 성명") may be the next name's cue.
  for (let m = NAME_RE.search(text, pos); m !== null; m = NAME_RE.search(text, pos)) {
    const prefix0 = group(m, 'prefix')
    if (prefix0 !== undefined && NAME_LIKE_603_SET.has(prefix0) && endOf(m, 'prefix') < startOf(m, 'label_sep')) {
      // A #603 title + particle that starts like a name ("원고은 차장") is a name when, read so,
      // a cue follows; otherwise it stays title + particle ("원고는 김민수", #674).
      const alt = NAME_NO_PREFIX_RE.match(text, startOf(m, 'prefix'))
      if (alt !== null && (group(alt, 'suffix') !== undefined || group(alt, 'paren') !== undefined)) m = alt
    }
    const atLineResume = m.index === lineResumeAt
    lineResumeAt = -1
    if (atLineResume && group(m, 'prefix') === undefined) {
      // The resumed cue read as an uncued candidate: go back to where the line's name consumed it (#662).
      pos = lineResumeEnd
      continue
    }
    const nameStart = startOf(m, 'name')
    const name = group(m, 'name')!
    const prefix = group(m, 'prefix')
    const suffix = group(m, 'suffix')
    const labelSep = group(m, 'label_sep')
    // Strong: both cues, a narrow form label, or a colon or bar after the label (#484).
    const hasExplicitSep = labelSep !== undefined && (labelSep.includes(':') || labelSep.includes('|'))
    const strong = (prefix !== undefined && suffix !== undefined) || (prefix !== undefined && STRONG_LABEL_PREFIXES.has(prefix)) || (prefix !== undefined && hasExplicitSep)
    if (CUE_WORDS.has(name) || isLabelWordAt(text, nameStart, strong)) {
      // A label word is no name. Resume at it when cued before, so it can cue the next name; at
      // the suffix when cued after, so a title is not consumed (#580).
      if (prefix !== undefined && ((!CUES_603.has(prefix) && CUES_603.has(name)) || PLURAL_ROLE_PREFIXES.has(name))) {
        // A #603 cue word after an older cue is dropped, but a list after it goes on (#674); a
        // plural court role after any cue too ("증인 원고들, 이서연", #685).
        listSeeds.push([endOf(m, 'name'), hasExplicitSep || STRONG_LABEL_PREFIXES.has(prefix)])
      }
      if (prefix !== undefined && nameStart > pos) pos = nameStart
      else if (suffix !== undefined) pos = startOf(m, 'suffix')
      else pos = endOf(m)
      continue
    }
    pos = endOf(m)
    if (suffix !== undefined && !NAME_LIKE_603_SET.has(suffix) && LINE_BREAK_RE.search(text, endOf(m, 'name'), startOf(m, 'suffix'))) {
      // The suffix was the next line's first word ("참석자: 송준경\n작성자: 문양석"), which is also
      // the next name's cue: resume there (#662).
      crossed = true
      if (resumeLines) {
        pos = resumeCue = lineResumeAt = startOf(m, 'suffix')
        lineResumeEnd = endOf(m)
      }
    }
    // 원고 and 박사 may start the next name ("오늘 원고은 님이"): resume at the title (#674).
    if (suffix !== undefined && NAME_LIKE_603_SET.has(suffix)) pos = startOf(m, 'suffix')
    if (nameStart > m.index && CUE_WITH_JOSA_RE.fullmatch(name)) {
      // A title + particle is no name; resume at it to cue the next one (#533).
      pos = nameStart
      continue
    }

    const hasPrefix = prefix !== undefined
    // A title, age, signature or contact in parentheses is a cue after too (#604).
    const parenTitle = group(m, 'paren_title')
    const paren = group(m, 'paren')
    const hasSuffix = suffix !== undefined || paren !== undefined
    if (!hasPrefix && !hasSuffix) continue // without any cue it cannot be told from an ordinary word

    // A title alone (before or after) needs surname + two syllables (#213, #239). A title before
    // pairs only with a title in parentheses ("부장 전결(인)").
    const after = suffix || parenTitle
    const titleOnly = (after !== undefined && TITLE_ONLY_CUES.has(after) && !hasPrefix) || (prefix !== undefined && TITLE_ONLY_CUES.has(prefix) && suffix === undefined && parenTitle === undefined)
    if (
      titleOnly &&
      name.length < 3 &&
      !twoCharTitleNameOk(name, prefix, suffix, {
        explicitSep: hasExplicitSep,
        glued: suffix !== undefined && startOf(m, 'suffix') === endOf(m, 'name'),
        // A court title counts only with the name right after, no particle ("검사가 유효")
        closed: closedAfter(text, endOf(m, 'name')) && (prefix === undefined || endOf(m, 'prefix') === startOf(m, 'label_sep')),
        common: isCommonWordAt(text, nameStart),
        titleEnds: suffix !== undefined && titleEndsAt(text, endOf(m, 'suffix')),
      })
    ) {
      if (prefix !== undefined && (TITLE_CUES_603.includes(prefix) || m.index === resumeCue)) {
        // A two-syllable name behind a #603 title: resume at the name so another cue can take it (#674, #676).
        pos = nameStart
      }
      continue
    }
    if (suffix !== undefined && TITLE_CUES_603.includes(suffix) && suffix.length === 2 && (prefix === undefined || CUES_603.has(prefix)) && TWO_CHAR_TITLE_JOSA_END_RE.search(name)) {
      continue // "정부의 책임": word + particle, not a name before a two-syllable title (#603)
    }
    if (suffix === '배상' && name.length < 3 && (prefix === undefined || CUES_603.has(prefix))) continue // "손해 배상" (#603, #674)
    const cues = [prefix, suffix].filter((c): c is string => c !== undefined)
    if (cues.length > 0 && cues.every(c => CUES_603.has(c)) && paren === undefined && isCommonWordAt(text, nameStart, CUE_603_COMMON_WORDS)) {
      continue // "피고인 진술": a common noun after a #603 cue
    }
    if (prefix !== undefined && (COURT_PREFIX_TITLES.has(prefix) || prefix === '받는 사람') && NAME_LIKE_TITLE_JOSA_RE.fullmatch(name)) {
      // "검사 원고가 김민수를": 원고가 cues 김민수; resume there (#663)
      pos = nameStart
      continue
    }
    if (
      prefix !== undefined &&
      (COURT_PREFIX_TITLES.has(prefix) || PLURAL_ROLE_PREFIXES.has(prefix)) &&
      suffix === undefined &&
      paren === undefined &&
      (WORD_CONTINUES_RE.match(text, endOf(m, 'name')) || isCommonWordAt(text, nameStart, COURT_CUE_COMMON_WORDS) || name.endsWith('으'))
    ) {
      // "검사 진단서 발급", "증인 신문이", "증인 신분으로" are no names; resume to let the word cue (#663)
      pos = nameStart
      continue
    }
    if (prefix !== undefined && PLURAL_ROLE_PREFIXES.has(prefix) && suffix === undefined && paren === undefined && name.length < 3) {
      // Two syllables after a plural role are mostly words ("원고들 주장에", #685)
      pos = nameStart
      continue
    }
    if (paren !== undefined && !hasPrefix) {
      // Only an age, contact or sex in parentheses overlaps two-syllable words ("정원(35)",
      // "구분(남/여)"): three-syllable names only.
      const parenWeak = group(m, 'paren_long') !== undefined || group(m, 'paren_sex') !== undefined
      if (parenWeak && name.length < 3) continue
      if (PAREN_COMMON_WORDS.has(name)) continue
    }

    if (prefix !== undefined && CUES_603.has(prefix) && suffix !== undefined && isLabelWordAt(text, nameStart)) {
      // A common word taken thanks to a #603 cue: resume at the suffix so it cues the next name (#674).
      pos = resumeCue = startOf(m, 'suffix')
    }
    const confidence = hasPrefix && hasSuffix ? 0.75 : 0.5
    let nameEnd = endOf(m, 'name')
    if (name.length === 3 && TITLE_TAIL_WORDS.has(name.slice(1))) {
      // "김부장님": surname + title; only the surname is covered, the list still goes on (#677).
      nameEnd = nameStart + 1
    }
    found.push(make(text, nameStart, nameEnd, confidence))
    if (prefix !== undefined) listSeeds.push([endOf(m, 'name'), hasExplicitSep || STRONG_LABEL_PREFIXES.has(prefix)])
  }
  return [found, listSeeds, crossed]
}

/** Whether a list cell ends like one (#602). */
function listTailOk(text: string, e: number): boolean {
  if (LIST_TAIL_SUFFIX_RE.match(text, e) || LIST_PUNCT_GAP_RE.match(text, e) || LIST_TAIL_JOSA_RE.match(text, e) || LIST_CLOSING_RE.match(text, e)) return true
  const nxt = text.slice(e, e + 1)
  return !nxt || nxt === '\r' || nxt === '\n' || LIST_TAIL_PUNCT.has(nxt)
}

/**
 * Names listed after a cued name (#602). seeds are (where the name ended, whether spaces alone
 * separate). Cells are collected while separators and names follow, up to the last cell that
 * ends like a list cell. Cells another rule found are not added again. Confidence 0.5.
 */
function listNames(text: string, seeds: readonly Seed[], found: readonly Detection[]): Detection[] {
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  for (const [seed, allowSpace] of seeds) {
    let pos = seed
    const cells: [number, number, boolean][] = []
    for (;;) {
      let gap = LIST_GAP_RE.match(text, pos)
      let spaceOnly = false
      if (gap === null && allowSpace) {
        gap = LIST_SPACE_GAP_RE.match(text, pos)
        spaceOnly = true
      }
      if (gap === null) break
      const m = LIST_NAME_RE.match(text, endOf(gap))
      if (m === null) break
      const [s, e] = span(m, 'name')
      const name = group(m, 'name')!
      if (
        (spaceOnly && name.length < LIST_SPACE_NAME_LEN) ||
        LIST_STOP_CUE_WORDS.has(name) ||
        isLabelWordAt(text, s) ||
        LIST_STOP_FORM_VALUES.has(FORM_VALUE_ENDING_RE.sub(name, '')) ||
        CUE_WITH_JOSA_OLD_RE.fullmatch(name) ||
        LIST_NOT_NAMES.has(name) ||
        LIST_NOT_NAME_LAST.has(name.at(-1)!) ||
        (name.length === 2 && startsWithAny(text, TITLE_ONLY_PREFIXES, e))
      ) {
        break
      }
      cells.push([s, e, listTailOk(text, e)])
      pos = e
    }
    let last = -1
    cells.forEach(([, , tailOk], i) => {
      if (tailOk) last = i
    })
    for (const [s, e] of cells.slice(0, last + 1)) {
      if (allCovered(covered, s, e)) continue
      covered.fill(1, s, e)
      extra.push(make(text, s, e, 0.5))
    }
  }
  return extra
}

/**
 * Names after a form label and a colon or bar (#491): names outside the surname list too, and
 * common words the cued scan dropped ("이하은"). Spans the cued scan covered are not added again.
 * A #603 state value is no name but seeds a list (#674).
 */
function formNames(text: string, found: readonly Detection[], listSeeds: Seed[]): Detection[] {
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  let pos = 0
  for (let m = FORM_NAME_RE.search(text, pos); m !== null; m = FORM_NAME_RE.search(text, pos)) {
    const [s, e] = span(m, 'name')
    const name = group(m, 'name')!
    const label = group(m, 'label')!
    const value = FORM_VALUE_ENDING_RE.sub(name, '')
    if (FORM_LABEL_SET.has(name) || FORM_LABEL_SET.has(value) || startsWithAny(text, MULTIWORD_FORM_LABELS, s) || isLabelWordAt(text, s, true)) {
      // Another label in the value's place ("성명: 예금주: 류서윤"): resume at it
      if (FORM_LABEL_603_SET.has(value)) listSeeds.push([e, true]) // "보호자: 결재, 김도현" (#674)
      pos = s
      continue
    }
    pos = e
    if (FORM_NOT_NAMES_603.has(value)) listSeeds.push([e, true])
    // #603 states are filtered only under #603 labels; older labels take them as names (#691).
    const notNames = FORM_LABEL_603_SET.has(label) ? FORM_NOT_NAMES : LIST_STOP_FORM_VALUES
    // A title + particle is no value either (#533)
    if (notNames.has(value) || CUE_WITH_JOSA_OLD_RE.fullmatch(name)) {
      if (label === '담당') listSeeds.push([e, true]) // "담당: 미정, 김민수" (#685)
      continue
    }
    if (
      label === '담당' &&
      (DUTY_LABEL_NOT_NAMES.has(value) || CUE_WORDS.has(value) || value.length < FOLLOWUP_MIN_NAME_LEN || !NAME_SHAPE_RE.fullmatch(value) || isCommonWordAt(text, s))
    ) {
      // "담당: 영업" is a duty: only a 3+ syllable name shape is a value, but a list after it goes on (#685)
      listSeeds.push([e, true])
      continue
    }
    if (allCovered(covered, s, e)) {
      // Found by the cued scan: still a list seed ("작성:김민구님,이서연")
      listSeeds.push([e, true])
      continue
    }
    if (ORG_VALUE_LABELS.has(label) && name.length >= 3 && ORG_VALUE_END_RE.search(name)) continue // departments ("홍보팀")
    extra.push(make(text, s, e, 0.75))
  }
  return extra
}

/** Values under a name column of a table (CSV, TSV, Markdown, #526), one line at a time. */
function tableNames(text: string, found: readonly Detection[]): Detection[] {
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  const lines = splitLines(text)
  let offset = 0
  let i = 0
  // The previous #603 header's (cell count, name columns), when a name-label header follows it
  let carry: [number, number[]] | undefined
  while (i < lines.length) {
    const line = lines[i]!
    let header = tableHeader(rstripNewlines(line))
    const weak = header === undefined
    if (weak) header = tableHeader(rstripNewlines(line), TABLE_WEAK_NAME_HEADERS)
    if (header === undefined) {
      carry = undefined
      offset += line.length
      i++
      continue
    }

    const [sep, cols, nCols] = header
    let nameCols = cols
    if (carry !== undefined && carry[0] === nCols) nameCols = [...new Set([...nameCols, ...carry[1]])].sort((a, b) => a - b) // both headers' name columns
    carry = undefined
    offset += line.length
    i++
    while (i < lines.length) {
      const row = lines[i]!
      const rowText = rstripNewlines(row)
      if (strip(rowText) === '') break // a blank line ends the table
      const cells = tableCells(rowText, sep)
      if (cells === undefined || cells.length !== nCols) break // the cell count changed (#526), or a field is too long
      if (isTableSeparatorRow(cells)) {
        offset += row.length
        i++
        continue // a Markdown separator row
      }
      if (weak && tableHeader(rowText) !== undefined) {
        // A name-label header under a #603 one ("작성 | 검토 | 승인"): it becomes the header (#674)
        carry = [nCols, nameCols]
        break
      }
      for (const nameCol of nameCols) {
        const [value, vs, ve] = cells[nameCol]!
        const s = offset + vs
        const e = offset + ve
        if (looksLikeTableName(value) && !allCovered(covered, s, e)) extra.push({ kind: 'name', start: s, end: e, text: value, confidence: 0.75 })
      }
      offset += row.length
      i++
    }
  }
  return extra
}

/** The first cell of a headerless slash record line, when it looks like a name (#581). */
function slashRecordNames(text: string, found: readonly Detection[]): Detection[] {
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  let offset = 0
  for (const line of splitLines(text)) {
    const body = rstripNewlines(line)
    const cells = body.split('/')
    if (cells.length - 1 >= SLASH_RECORD_MIN_CELLS - 1) {
      const lead = endOf(SLASH_RECORD_LEAD_RE.match(cells[0]!)!)
      const value = rstrip(cells[0]!.slice(lead))
      const s = offset + lead
      const e = s + value.length
      if (looksLikeSlashRecordName(value) && cells.slice(1).some(cell => SLASH_RECORD_DETAIL_RE.search(cell) !== null) && !allCovered(covered, s, e)) {
        extra.push({ kind: 'name', start: s, end: e, text: value, confidence: 0.5 })
      }
    }
    offset += line.length
  }
  return extra
}

/** A table value's test plus a surname start and no common word: no header vouches for it. */
const looksLikeSlashRecordName = (value: string): boolean =>
  value.length >= SLASH_RECORD_MIN_NAME_LEN && looksLikeTableName(value) && startsWithAny(value, SURNAMES) && !CUE_WORDS.has(value) && !isCommonWordAt(value, 0)

/** (separator, name column indices, cell count) when the line is a table header with a label in require. */
function tableHeader(line: string, require: ReadonlySet<string> = TABLE_NAME_HEADERS): [string, number[], number] | undefined {
  for (const sep of TABLE_SEPS) {
    if (!line.includes(sep)) continue
    const cells = tableCells(line, sep)
    if (cells === undefined || cells.length < 2) continue
    if (cells.some(([value]) => require.has(value))) {
      const cols = cells.flatMap(([value], idx) => (TABLE_NAME_COLUMN_LABELS.has(value) ? [idx] : []))
      return [sep, cols, cells.length]
    }
  }
  return undefined
}

/**
 * The line's cells as (value, start, end), split like Python's csv module (a quoted cell keeps
 * the separator, its quotes are removed); undefined where csv raises. Positions are found in order.
 */
function tableCells(line: string, sep: string): [string, number, number][] | undefined {
  const rawValues = csvRow(line, sep)
  if (rawValues === undefined) return undefined
  const cells: [string, number, number][] = []
  let pos = 0
  for (const raw of rawValues) {
    const value = strip(raw)
    let idx = line.indexOf(value, pos)
    if (idx === -1) idx = pos
    cells.push([value, idx, idx + value.length])
    pos = idx + value.length
  }
  return cells
}

// csv.reader with the default dialect (excel, not strict) on one line without line breaks.
// It raises only for a field over the field size limit.
const FIELD_LIMIT = 131072

function csvRow(line: string, delimiter: string): string[] | undefined {
  const fields: string[] = []
  let field = ''
  let state: 'start' | 'field' | 'quoted' | 'quote' = 'start'
  const add = (c: string): boolean => {
    if (field.length >= FIELD_LIMIT) return false
    field += c
    return true
  }
  const save = (): void => {
    fields.push(field)
    field = ''
  }
  for (const c of line) {
    if (state === 'start' || state === 'field') {
      if (state === 'start' && c === '"') state = 'quoted'
      else if (c === delimiter) {
        save()
        state = 'start'
      } else {
        if (!add(c)) return undefined
        state = 'field'
      }
    } else if (state === 'quoted') {
      if (c === '"') state = 'quote'
      else if (!add(c)) return undefined
    } else if (c === '"') {
      // A doubled quote inside quotes is one quote
      if (!add(c)) return undefined
      state = 'quoted'
    } else if (c === delimiter) {
      save()
      state = 'start'
    } else {
      if (!add(c)) return undefined
      state = 'field'
    }
  }
  if (line.length > 0) save()
  return fields
}

/** Whether every cell is dashes, colons and spaces, and one is not empty (a Markdown separator row). */
function isTableSeparatorRow(cells: readonly [string, number, number][]): boolean {
  let hasContent = false
  for (const [value] of cells) {
    if (!TABLE_SEPARATOR_CELL_RE.fullmatch(value)) return false
    if (value) hasContent = true
  }
  return hasContent
}

/** Whether a table value looks like a name: the form field's test. */
function looksLikeTableName(value: string): boolean {
  if (!TABLE_NAME_VALUE_RE.fullmatch(value)) return false
  if (FORM_LABEL_SET.has(value) || FORM_NOT_NAMES.has(value)) return false
  // A three-syllable role word in a value cell is the next line's label (#662); two-syllable
  // cue words can be names with a one-syllable surname ("선수", "박사").
  if (CUE_WORDS.has(value) && value.length >= 3) return false
  if (CUE_WITH_JOSA_OLD_RE.fullmatch(value)) return false
  return !isLabelWordAt(value, 0, true)
}

/** str.rstrip("\r\n"). */
const rstripNewlines = (line: string): string => line.replace(/[\r\n]+$/, '')

/** A one-cue (0.5) name; "김부장" covers the surname only unless keepTitleTail is false (#677). */
function nameDetection(text: string, s: number, e: number, keepTitleTail = true): Detection {
  if (keepTitleTail && e - s === 3 && TITLE_TAIL_WORDS.has(text.slice(s + 1, e))) e = s + 1
  return make(text, s, e, 0.5)
}

/** Whether a cell taken without cues is no common, label or cue word (#685), listNames' test and two more. */
function plainNameCell(text: string, s: number, name: string): boolean {
  return !(
    CUE_WORDS.has(name) ||
    isLabelWordAt(text, s) ||
    LIST_STOP_FORM_VALUES.has(FORM_VALUE_ENDING_RE.sub(name, '')) ||
    CUE_WITH_JOSA_OLD_RE.fullmatch(name) ||
    LIST_NOT_NAMES.has(name) ||
    LIST_NOT_NAME_LAST.has(name.at(-1)!) ||
    (name.length === 3 && CUE_WORDS.has(name.slice(0, 2)) && JOSA_CHARS.has(name[2]!)) ||
    '에는를을과와면며'.includes(name[1]!)
  )
}

/** Names before "외 N명", "등 N명" (#685). */
function countTailNames(text: string, found: readonly Detection[]): Detection[] {
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  for (const m of COUNT_TAIL_RE.finditer(text)) {
    const [s, e] = span(m, 'name')
    const name = group(m, 'name')!
    if (name.length < FOLLOWUP_MIN_NAME_LEN || allCovered(covered, s, e) || COUNT_TAIL_NOT_NAMES.has(name) || COUNT_TAIL_NOT_LAST.has(name.at(-1)!) || !plainNameCell(text, s, name)) continue
    covered.fill(1, s, e)
    extra.push(nameDetection(text, s, e))
  }
  return extra
}

/** "[이름] [오후 3:01]" at a line start of a messenger export (#685). */
function bracketNames(text: string, found: readonly Detection[]): Detection[] {
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  for (const m of BRACKET_NAME_RE.finditer(text)) {
    const [s, e] = span(m, 'name')
    if (allCovered(covered, s, e) || !plainNameCell(text, s, group(m, 'name')!)) continue
    covered.fill(1, s, e)
    extra.push(nameDetection(text, s, e))
  }
  return extra
}

/**
 * Names joined by commas or middle dots before a name with a cue after ("김민수, 이서연 님께",
 * #685): one cell at a time backwards, each filtered like listNames. Linear.
 */
function reverseListNames(text: string, found: readonly Detection[]): Detection[] {
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  const anchors = [...new Set(found.filter(d => LIST_TAIL_SUFFIX_RE.match(text, d.end) || COUNT_AFTER_RE.match(text, d.end)).map(d => d.start))].sort((a, b) => a - b)
  for (const anchor of anchors) {
    let pos = anchor
    for (;;) {
      let k = pos
      while (k > 0 && ' \t'.includes(text[k - 1]!)) k--
      if (k === 0 || !REVERSE_LIST_SEPS.has(text[k - 1]!)) break
      k--
      while (k > 0 && ' \t'.includes(text[k - 1]!)) k--
      let cell: [number, string] | undefined
      for (const n of [4, 3, 2]) {
        const st = k - n
        if (st < 0 || (st > 0 && isHangul(text[st - 1]!))) continue
        const m = LIST_NAME_RE.match(text, st)
        if (m !== null && endOf(m, 'name') === k) {
          cell = [st, group(m, 'name')!]
          break
        }
      }
      if (cell === undefined) break
      const [st, name] = cell
      if (name.length < FOLLOWUP_MIN_NAME_LEN || !plainNameCell(text, st, name)) break
      if (!allCovered(covered, st, k)) {
        covered.fill(1, st, k)
        extra.push(nameDetection(text, st, k))
      }
      pos = st
    }
  }
  return extra
}

/** "인사팀 김민수입니다" after a greeting, and "제 이름은 황재고요" (#663). */
function selfIntroNames(text: string, found: readonly Detection[]): Detection[] {
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  for (const m of SELF_INTRO_RE.finditer(text)) {
    const [s, e0] = span(m, 'name')
    const name = group(m, 'name')!
    const e = keepIRaAfterShortName(text, s, e0)
    if (
      allCovered(covered, s, e) ||
      SELF_INTRO_NOT_ORG_ENDS.some(w => group(m, 'org')!.endsWith(w)) ||
      (name.length === 3 && SELF_INTRO_NOT_NAME_LAST.has(name[2]!)) ||
      SELF_INTRO_NOT_NAMES.has(name) ||
      COMMON_WORDS.has(name) ||
      TITLE_CONTEXT_WORDS.has(name) ||
      COUNT_TAIL_NOT_NAMES.has(name) ||
      COURT_CUE_COMMON_WORDS.has(name) ||
      !plainNameCell(text, s, name)
    ) {
      continue
    }
    covered.fill(1, s, e)
    extra.push(nameDetection(text, s, e, false))
  }
  for (const m of MY_NAME_IS_RE.finditer(text)) {
    const [s, e0] = span(m, 'name')
    const name = group(m, 'name')!
    const e = keepIRaAfterShortName(text, s, e0)
    // "제 이름은" is the cue, so common-word names count; labels and cue words do not.
    if (allCovered(covered, s, e) || CUE_WORDS.has(name) || isLabelWordAt(text, s, true)) continue
    covered.fill(1, s, e)
    extra.push(nameDetection(text, s, e, false))
  }
  return extra
}

/** A short name read before "이" or "라" covers it too: "주한이고요" may be 주한이 + 고요 (#663). */
function keepIRaAfterShortName(text: string, s: number, e: number): number {
  const short = e - s === 2 || (e - s === 3 && COMPOUND_SURNAMES.has(text.slice(s, s + 2)))
  const nxt = text.slice(e, e + 1)
  return short && (nxt === '이' || nxt === '라') ? e + 1 : e
}

/** The second name of "에서 ○○○(으)로 변경" after a found name (#589). */
function changeLogNames(text: string, found: readonly Detection[]): Detection[] {
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  const anchors = [...new Set(found.filter(d => text.startsWith('에서', d.end)).map(d => d.end))].sort((a, b) => a - b)
  for (const anchor of anchors) {
    const m = CHANGE_LOG_NEXT_RE.match(text, anchor)
    if (m === null) continue
    const [s, e] = span(m, 'name')
    const name = group(m, 'name')!
    if (allCovered(covered, s, e) || TITLE_CONTEXT_WORDS.has(name) || COUNT_TAIL_NOT_NAMES.has(name) || SELF_INTRO_NOT_NAMES.has(name) || !plainNameCell(text, s, name)) continue
    covered.fill(1, s, e)
    extra.push(nameDetection(text, s, e, false))
  }
  return extra
}

/**
 * A found name of three or four syllables appearing again without a cue (#608). Only names with
 * strong evidence spread: both cues (0.75) in the cued scan, a name-only form label, or a role
 * word or self-introduction before and "입니다" after. One linear pass over word starts.
 */
function repeatNames(text: string, found: readonly Detection[], cued: readonly Detection[], form: readonly Detection[]): Detection[] {
  const nameFormStarts = new Set<number>()
  for (const m of FORM_NAME_RE.finditer(text)) if (REPEAT_SEED_FORM_LABELS.has(group(m, 'label')!)) nameFormStarts.add(startOf(m, 'name'))
  const introStarts = new Set<number>()
  for (const m of SELF_INTRO_RE.finditer(text)) introStarts.add(startOf(m, 'name'))
  for (const m of MY_NAME_IS_RE.finditer(text)) introStarts.add(startOf(m, 'name'))
  const sources = [
    ...cued.filter(d => d.confidence >= 0.75),
    ...[...cued, ...form].filter(d => nameFormStarts.has(d.start)),
    ...found.filter(d => startsWithAny(text, REPEAT_SEED_ENDINGS, d.end) && (introStarts.has(d.start) || roleCueBefore(text, d.start))),
  ]
  const seeds = new Set<string>()
  for (const d of sources) {
    const name = text.slice(d.start, d.end)
    if (name.length >= FOLLOWUP_MIN_NAME_LEN && name.length <= 4 && [...name].every(isHangul) && !REPEAT_NOT_SEEDS.has(name)) seeds.add(name)
  }
  if (seeds.size === 0) return []
  const covered = coverage(text.length, found)
  const extra: Detection[] = []
  for (const m of HANGUL_RUN_RE.finditer(text)) {
    const s = m.index
    let name: string | undefined
    for (const n of [4, 3]) {
      const cand = text.slice(s, s + n)
      if (cand.length === n && seeds.has(cand) && s + n <= endOf(m) && nameCouldEndAt(text, s + n)) {
        name = cand
        break
      }
    }
    if (name === undefined) continue
    const e = repeatNameEnd(text, s, s + name.length, name)
    if (allCovered(covered, s, e) || !plainNameCell(text, s, name)) continue
    covered.fill(1, s, e)
    extra.push(nameDetection(text, s, e, false))
  }
  return extra
}

/**
 * A repeated three-syllable name covers the next syllable when it may be the name's last
 * ("선우하" in "선우하은"): a particle that does not fit the final consonant, 라 or 란, or any
 * syllable after a compound surname + one (#608).
 */
function repeatNameEnd(text: string, s: number, e: number, name: string): number {
  if (e - s !== 3 || !isHangul(text.slice(e, e + 1) || ' ') || !nameCouldEndAt(text, e + 1)) return keepIRaAfterShortName(text, s, e)
  const nxt = text[e]!
  const hasFinal = (name.charCodeAt(name.length - 1) - 0xac00) % 28 !== 0
  if (COMPOUND_SURNAMES.has(name.slice(0, 2)) || '라란'.includes(nxt) || (!hasFinal && '은을과이'.includes(nxt)) || (hasFinal && '는가를와'.includes(nxt))) return e + 1
  return e
}

/**
 * Names found by a cued scan, then by form labels, table columns, slash records and lists.
 * A suffix read across a line break (#662) triggers a second scan that resumes there; the two
 * are merged, so it never covers less than the first scan alone.
 */
export function detectName(text: string): Detection[] {
  const [found, listSeeds, crossed] = scanCued(text, false)
  if (crossed) {
    const [again, againSeeds] = scanCued(text, true)
    const have = new Set(found.map(d => `${d.start}:${d.end}`))
    found.push(...again.filter(d => !have.has(`${d.start}:${d.end}`)))
    found.sort((a, b) => a.start - b.start || a.end - b.end)
    const seeds = new Set(listSeeds.map(([p, a]) => `${p}:${a}`))
    listSeeds.push(...againSeeds.filter(([p, a]) => !seeds.has(`${p}:${a}`)))
  }
  const cued = [...found]
  const formExtra = formNames(text, found, listSeeds)
  const tableExtra = tableNames(text, [...found, ...formExtra])
  const slashExtra = slashRecordNames(text, [...found, ...formExtra, ...tableExtra])
  found.push(...formExtra, ...tableExtra, ...slashExtra)
  // A name after a form label is a list start too, spaces allowed.
  listSeeds.push(...formExtra.map((d): Seed => [d.end, true]))
  found.push(...listNames(text, listSeeds, found))
  // #685, #663, #589, #608: each only adds.
  found.push(...countTailNames(text, found))
  found.push(...bracketNames(text, found))
  found.push(...reverseListNames(text, found))
  found.push(...selfIntroNames(text, found))
  found.push(...changeLogNames(text, found))
  found.push(...repeatNames(text, found, cued, formExtra))
  return found
}
