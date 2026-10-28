// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/personal/address.py), with modifications.

// Addresses, anchored on a province or city name and widened as far as the parts continue:
// city/county/district (two levels), town/neighbourhood or road name, lot or building number,
// building name with block, floor and unit. More parts give more confidence. Covering only the
// province and leaving "월드컵로237길 49 ..." is in effect a leak (#66), so the span goes to the end.
//  - Abbreviated provinces ("서울 강남구 테헤란로 123") and cities without "시" ("수원 영통구 ...")
//    need a district and then a locality (#396); 세종 needs a number (#465).
//  - City or county anchors without a province need a district or locality after (#68, #425).
//  - District anchors ("주소: 강남구 테헤란로 123") need an address cue nearby (#492).
//  - Several spaces or a CRLF between parts: also searched in a copy with them collapsed (#492).

import type { Detection } from './overlaps'
import { isSpace, Re, type Match } from './regex'

const PROVINCES = [
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시', '세종특별자치시',
  '경기도', '강원특별자치도', '강원도', '충청북도', '충청남도', '전북특별자치도', '전라북도', '전라남도', '경상북도', '경상남도',
  '제주특별자치도', '제주도',
  // 2026-06-30 merger of 광주광역시 and 전라남도 (MOLIT legal district data); the old names stay in use.
  '전남광주통합특별시',
]

const byLengthDesc = (names: readonly string[]): string[] => [...names].sort((a, b) => b.length - a.length)

// Longest first, so "전라북도" does not take the place of "전북특별자치도".
const PROVINCE_RE = byLengthDesc(PROVINCES).join('|')

// Abbreviated provinces (#396), all two syllables. 세종 is left out (see SEJONG_AHEAD).
const PROVINCE_ABBR = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주']
const GU_CITY_ABBR = ['수원', '성남', '고양', '용인', '안양', '안산', '부천', '청주', '천안', '전주', '포항', '창원']
// Cities without districts: a start without "시" only after an address cue and with a road and number (#606).
const NO_GU_CITY_ABBR = ['남양주', '김해', '화성', '평택', '파주', '김포', '시흥', '이천']
const ABBR_ANCHORS = byLengthDesc([...PROVINCE_ABBR, ...GU_CITY_ABBR])
const NO_GU_CITY_ABBR_RE = byLengthDesc(NO_GU_CITY_ABBR).join('|')

// Particles glued to a name are ordinary Korean ("본사는 서울특별시에 있다"), and other Hangul
// glued on makes another word ("서울특별시청", #196). The copula's forms are allowed (#248).
// Long ones first, so "에서" is not cut to "에". Also used for word ends below (#423).
const JOSA = '입니다|입니까|예요|였|에서|에게|으로|까지|부터|처럼|보다|조차|마저|밖에|마다|한테|의|에|로|은|는|이|가|을|를|과|와|도|만'

// --- The locality slot (#423) ---
// A cut here leaves the road and building number showing. Specific readings are tried first,
// then the old rule; none ends shorter than the old rule did (checked on 60,000 random inputs).
const BUNJI = '\\d{1,4}(?:-\\d{1,4})?'
// A building number follows: the word before is certainly a road. Longer numbers (resident,
// phone) are not building numbers.
const BUNJI_AHEAD = '(?=\\s' + BUNJI + '(?![\\d-]))'
// The word has ended: only particles follow, then no more Hangul or digits.
const END = '(?=(?:' + JOSA + ')?(?![가-힣0-9]))'
// Road names can hold digits ("센텀2로", "올림픽로35가길"). A word ending in the particle "으로"
// is not a road ("역삼동으로 12명").
const ROAD = '[가-힣][가-힣0-9]{0,9}(?<!으)(?:로|길)(?:\\s?\\d{1,4}번?길)?'
// After a road name the particle is "로", never "으로", so "으로" does not end it here.
const ROAD_END = '(?=(?:' + JOSA.split('|').filter(j => j !== '으로').join('|') + ')?(?![가-힣0-9]))'
// Town or neighbourhood; administrative ones carry digits ("신림2동"), and "을지로3가".
const DONG = '[가-힣]{1,10}(?:\\d{1,2}(?:동|리|가)|동|읍|면|리)'
// Two-part slots: town then village ("양평읍 양근리 123"), and locality then road with a number
// after ("해남읍 중앙1로 330", "역삼동 테헤란로 123", "종로1가 새솔로 12").
const TWO_PART =
  '[가-힣]{1,10}(?:읍|면)\\s[가-힣]{1,10}\\d{0,2}리' + END + '|[가-힣]{1,10}(?:\\d{1,2}(?:동|가)|동|읍|면)\\s' + ROAD + BUNJI_AHEAD
// The first reading that holds is used; the order is the priority.
const LOCALITY =
  '(?:' +
  TWO_PART +
  ')' +
  // A road with a number after: before the locality reading, so "대동로 12" is not "대동" + "로".
  '|' +
  ROAD +
  BUNJI_AHEAD +
  // A locality whose word ends ("역삼동으로 이사")
  '|' +
  DONG +
  END +
  // A road whose word ends, without a number ("대동로에서")
  '|' +
  ROAD +
  ROAD_END +
  // The old rule, when all else fails ("역삼동쪽으로")
  '|[가-힣]{1,10}(?:동|읍|면|리)|[가-힣]{1,10}(?:로|길)(?:\\s?\\d{1,4}번?길)?'

// The district slots, two levels ("성남시 분당구"). A word that is a locality or a road with a
// number is not read as a district (#465): "장군면" read as "장군" left "면 ..." showing.
const NOT_LOCALITY = '(?!' + DONG + END + '|' + ROAD + BUNJI_AHEAD + ')'
// A district glued to the province or city ("서울강남구", "성남시분당구", #465) only when the word
// ends there, and not when it holds a full province name. Two-syllable districts are only the
// five 중구, 동구, 서구, 남구, 북구; others ("인구", "지구") made "경기도인구 1400만" an address.
const GLUED_GU_WORD = '(?:[중동서남북]구|(?!시군구)[가-힣]{2,10}[시군구])'
const GLUED_GU_AHEAD = '(?![가-힣]{0,9}(?:' + PROVINCE_RE + '))(?=' + GLUED_GU_WORD + END + ')'
const GU = '(?:(?:\\s|' + GLUED_GU_AHEAD + ')' + NOT_LOCALITY + '(?P<gu>[가-힣]{1,10}[시군구]))?'
// The second slot must end in 군 or 구; it would read the "대구" of "대구광역시" and chain a list of addresses.
const GU2 = '(?:\\s' + NOT_LOCALITY + '(?!' + PROVINCE_RE + ')(?P<gu2>[가-힣]{1,10}[군구]))?'

// --- After the number: building, block, floor, unit, and the reference note (#605) ---
const BUILDING_SUFFIX =
  '아파트|빌라|오피스텔|맨션|타워|빌딩|센터|스퀘어|프라자|플라자|타운|파크|캐슬|하이츠|빌리지' + '|팰리스|레지던스|상가|연립|주택'
// Floors: "지하 1층", "B1", "12층", "4F"; a particle may follow. A letter after makes a word ("B2B").
const FLOOR = '(?:(?:지하|지상)\\s?\\d{1,2}층|[Bb]\\d{1,2}층?|\\d{1,3}층|\\d{1,2}[Ff])(?![A-Za-z])' + END
// Units: "B101호" too; not "2호점".
const HO = '[A-Za-z]?\\d{1,5}호' + END
// Block-unit shorthand; the second group has three digits or more, so "3-4호선" stays out.
const HYPHEN_UNIT = '\\d{2,4}-\\d{3,5}호?(?![\\d-])' + END
const UNIT_HO = '(?:' + HO + '|' + HYPHEN_UNIT + ')'
// Building blocks: "101동", "A동"; a Hangul block ("가동") only with a floor or unit after, being
// shaped like "자동" and "아동".
const SEP = '[,\\s]\\s{0,3}'
const BUILDING_DONG = '(?:\\d{1,4}동|[A-Za-z]동|[가나다라마바사아자차카타파하]동(?=' + SEP + '(?:' + FLOOR + '|' + HO + ')))'
// Usually a space or comma before the unit, but "101동1203호" is written together too.
const UNIT_SEP = '(?:' + SEP + '|(?<=동))'
// "동" glued to a building word ("한빛타워동 1203호") is that building's block, when a floor or unit follows.
const GLUED_BUILDING_DONG = '(?:동(?=' + SEP + '(?:' + FLOOR + '|' + UNIT_HO + ')|' + UNIT_HO + '))?'
// A floor after the unit ("1203호 12층").
const FLOOR_AFTER_HO = '(?:' + SEP + '(?P<floor_after_ho>' + FLOOR + '))?'

const TAIL =
  '(?:\\s(?P<dong>' +
  LOCALITY +
  '))?' +
  // A digit or hyphen after the number makes it part of a longer one; "123번지" spelled out (#340).
  '(?:\\s(?P<bunji>' +
  BUNJI +
  ')(?![\\d-])(?:번지)?(?:\\s?호)?)?' +
  // Building name and block and unit ("더샵아파트 123동 1241호"), a comma allowed before (#265).
  // A name without a building word ("더샵퍼스트월드") only right before a block, floor or unit
  // (#605). Words ending in 님 or 씨 are honorific names, not buildings.
  '(?:[,\\s]\\s*(?P<building>[0-9A-Za-z가-힣]{1,20}(?:' +
  BUILDING_SUFFIX +
  ')' +
  GLUED_BUILDING_DONG +
  ')' +
  '|' +
  SEP +
  '(?P<building_named>[A-Za-z가-힣][0-9A-Za-z가-힣]{1,19})(?<![님씨])' +
  '(?=' +
  SEP +
  '(?:' +
  BUILDING_DONG +
  '|' +
  FLOOR +
  '|' +
  HO +
  ')))?' +
  '(?:[,\\s]\\s*(?P<building_dong>' +
  BUILDING_DONG +
  '))?' +
  '(?:' +
  SEP +
  '(?P<floor>' +
  FLOOR +
  '))?' +
  '(?:' +
  UNIT_SEP +
  '(?P<building_ho>' +
  UNIT_HO +
  ')' +
  FLOOR_AFTER_HO +
  ')?' +
  // The reference note of road addresses ("(역삼동)", "(역삼동, 더샵아파트)"): a name ending in
  // 동, 가 or 리; the second item starts with a letter, not a number that may be a resident one.
  '(?:\\s{0,3}\\((?P<reference>[가-힣]{1,10}\\d{0,2}(?:동|가|리)' +
  '(?:\\s{0,3},\\s{0,3}[가-힣A-Za-z][0-9A-Za-z가-힣]{0,19})?)\\))?'

// A building and unit with no province or road ("한빛아파트 101동 302호로 보내 주세요", #593):
// a building word and then block/floor/unit; without a unit it is not taken.
const BUILDING_UNIT_RE = new Re(
  '(?<![0-9A-Za-z가-힣])(?P<building>[0-9A-Za-z가-힣]{1,20}(?:' +
    BUILDING_SUFFIX +
    ')' +
    GLUED_BUILDING_DONG +
    ')' +
    '(?:' +
    SEP +
    '(?P<building_dong>' +
    BUILDING_DONG +
    '))?' +
    '(?:' +
    SEP +
    '(?P<floor>' +
    FLOOR +
    '))?' +
    '(?:' +
    UNIT_SEP +
    '(?P<building_ho>' +
    UNIT_HO +
    '))' +
    FLOOR_AFTER_HO,
)
const BUILDING_UNIT_CONFIDENCE = 0.6

const ADDR_RE = new Re(
  // Non-particle Hangul glued to the province makes another word (#196); a glued district is fine (#465).
  '(?P<province>' + PROVINCE_RE + ')' + '(?:' + GLUED_GU_AHEAD + '|(?!(?!' + JOSA + ')[가-힣]))' + GU + GU2 + TAIL,
)

// --- A road right after a city or county (#425) ---
// "…시" and "…군" are common words, so: the road has three syllables or more (no "새로",
// "따로"), and no Hangul right after the number except 번지, 호 and particles (#465), leaving out
// "12명이", "3건이"; 만 and 도 are left out too, being counters as well ("12만 명", "30도").
const ROAD3 = '[가-힣][가-힣0-9]{1,9}(?<!으)(?:로|길)(?:\\s?\\d{1,4}번?길)?'
const BUNJI_JOSA = '입니다|이에요|예요|에서|에게|으로|까지|부터|처럼|보다|의|에|로|은|는|이|을|를|과|와'
const BUNJI_AHEAD_STRICT = '(?=\\s' + BUNJI + '(?![\\d-])(?:번지|호)?(?:' + BUNJI_JOSA + ')?(?![가-힣]))'

// 세종 without 시 (#465): only when a number follows, the name being common in people and roads.
const SEJONG_AHEAD =
  '(?=\\s(?:[가-힣]{1,10}(?:\\d{1,2}(?:동|리)|동|읍|면|리)' + '(?:\\s' + ROAD3 + '|\\s[가-힣]{1,10}\\d{0,2}리)?' + '|' + ROAD3 + ')' + BUNJI_AHEAD_STRICT + ')'

// City or county without a province (#68): needs a district or locality after, or a road with a number (#425).
const ADDR_NO_PROVINCE_RE = new Re(
  '(?<![가-힣])(?P<si>[가-힣]{2,9}[시군])' +
    '(?:(?=\\s(?:[가-힣]{1,10}(?:\\d{1,2}(?:동|리)|구|동|읍|면|리)|' +
    ROAD3 +
    BUNJI_AHEAD_STRICT +
    '))' +
    // A district glued to the city ("성남시분당구 정자동 45-6", #465)
    '|(?=(?:[중동서남북]구|[가-힣]{2,10}구)' +
    END +
    '))' +
    GU +
    GU2 +
    TAIL,
)

// Abbreviated provinces (#396): a district must follow, spaced or glued (#465). The locality is checked in detect.
const ADDR_ABBR_RE = new Re(
  '(?<![가-힣])(?:(?P<abbr>' +
    ABBR_ANCHORS.join('|') +
    ')(?!특별|광역)' +
    '(?:(?=\\s' +
    NOT_LOCALITY +
    '[가-힣]{1,10}[시군구])|' +
    GLUED_GU_AHEAD +
    ')' +
    '|세종' +
    SEJONG_AHEAD +
    ')' +
    GU +
    GU2 +
    TAIL,
)

// "김해 장유로 123": a city without districts and without 시; detect checks for an address cue before.
const ADDR_NO_GU_CITY_ABBR_RE = new Re('(?<![가-힣])(?P<abbr>' + NO_GU_CITY_ABBR_RE + ')(?=\\s' + ROAD3 + BUNJI_AHEAD_STRICT + ')' + GU + GU2 + TAIL)

// A district with no province or city ("주소: 강남구 테헤란로 123", #492), only with an address cue.
// Two-syllable districts are only the five, as for glued districts.
const ADDR_GU_RE = new Re('(?<![가-힣])(?P<si>[중동서남북]구|[가-힣]{2,9}구)(?=\\s(?:' + DONG + '|' + ROAD3 + '))' + GU + GU2 + TAIL)
const GU_CUE_RE = new Re('주소|거주|소재지|배송|수령|도착지|자택|사업장|위치|사는 곳|본적|등록기준지|우편|배달')
const GU_CUE_WINDOW = 15
const GU_NON_ADDRESS_WORDS = new Set(['지역구', '선거구', '행정구', '자치구'])

// Gaps that are not one space (#492): two or more horizontal spaces, and one line break with
// CRLF or spaces mixed in. Blank lines and paragraph separators are not collapsed.
const HSPACE = '[ \\t\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]'
const WIDE_SPACE_RE = new Re(HSPACE + '*\\r\\n' + HSPACE + '*|' + HSPACE + '+\\n' + HSPACE + '*|\\n' + HSPACE + '+|' + HSPACE + '{2,}')
// [^\S\r\n]: Python's whitespace without CR and LF.
const PARAGRAPH_BREAK_RE = new Re('\\r?\\n[\\t\\v\\f\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*\\r?\\n|[\\u2028\\u2029]')

/** Where the line holding index ends; within limit when given. */
function lineEnd(text: string, index: number, limit = text.length): number {
  const ends = ['\r', '\n', '\u2028', '\u2029'].map(sep => text.indexOf(sep, index)).filter(pos => pos !== -1 && pos + 1 <= limit)
  return ends.length > 0 ? Math.min(...ends) : text.length
}

/** Where the paragraph holding index starts: after a blank line or a paragraph separator. */
function paragraphStart(text: string, index: number): number {
  let s = 0
  for (const m of PARAGRAPH_BREAK_RE.finditer(text, 0, index)) s = m.index + m[0].length
  return s
}

/** Whether only indentation stands between the line start and start: a list item. */
function startsLineIgnoringSpace(text: string, s: number): boolean {
  let i = s - 1
  while (i >= 0 && !'\r\n\u2028\u2029'.includes(text[i]!) && isSpace(text[i]!)) i--
  return i < 0 || '\r\n\u2028\u2029'.includes(text[i]!)
}

const hasLeadingAddressCue = (text: string, s: number): boolean => GU_CUE_RE.search(text, Math.max(0, s - GU_CUE_WINDOW), s) !== null

/**
 * Whether a district-anchored candidate has enough of an address cue: within 15 characters
 * before (#492); later on the same line ("강남구 역삼동 12 (배송지)"); or, for a list item, in the
 * same paragraph above. A blank line is not crossed.
 */
function hasGuCue(text: string, s: number, e: number): boolean {
  if (hasLeadingAddressCue(text, s)) return true
  const afterLimit = Math.min(text.length, e + GU_CUE_WINDOW)
  if (GU_CUE_RE.search(text, e, Math.min(lineEnd(text, e, afterLimit), afterLimit))) return true
  if (startsLineIgnoringSpace(text, s)) return GU_CUE_RE.search(text, paragraphStart(text, s), s) !== null
  return false
}

/**
 * The text with wide gaps collapsed to one space, and the map from collapsed to original
 * positions. Only the boundaries are stored: after each collapsed gap the two run in step.
 */
function collapseWideSpaces(text: string): [string, (index: number) => number] {
  // From marks[k] on, the collapsed text runs with the original from origins[k] on.
  const marks = [0]
  const origins = [0]
  for (const m of WIDE_SPACE_RE.finditer(text)) {
    marks.push(marks.at(-1)! + m.index - origins.at(-1)! + 1)
    origins.push(m.index + m[0].length)
  }
  const toOriginal = (index: number): number => {
    // bisect_right(marks, index) - 1
    let lo = 0
    let hi = marks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (index < marks[mid]!) hi = mid
      else lo = mid + 1
    }
    const k = lo - 1
    return origins[k]! + index - marks[k]!
  }
  return [WIDE_SPACE_RE.sub(text, ' '), toOriginal]
}

type Candidate = [number, number, number]

/** Candidates (start, end, confidence) of the anchors: province, abbreviation, city or county, district, building. */
function candidatesOf(text: string): Candidate[] {
  const candidates: Candidate[] = []
  // Province anchor: from 0.5
  for (const m of ADDR_RE.searchEveryStart(text)) candidates.push([m.index, m.index + m[0].length, score(m, 0.5, 1.0)])
  // The others have no full province name: from 0.4, and a district alone is no address.
  for (const pattern of [ADDR_ABBR_RE, ADDR_NO_PROVINCE_RE, ADDR_NO_GU_CITY_ABBR_RE, ADDR_GU_RE]) {
    for (const m of pattern.searchEveryStart(text)) {
      if (!m.groups!.dong) continue
      if (pattern === ADDR_NO_GU_CITY_ABBR_RE && !hasLeadingAddressCue(text, m.index)) continue
      if (pattern === ADDR_GU_RE && (GU_NON_ADDRESS_WORDS.has(m.groups!.si!) || !hasGuCue(text, m.index, m.index + m[0].length))) continue
      candidates.push([m.index, m.index + m[0].length, score(m, 0.4, 0.9)])
    }
  }
  // Building units without an anchor (#593)
  for (const m of BUILDING_UNIT_RE.finditer(text)) candidates.push([m.index, m.index + m[0].length, BUILDING_UNIT_CONFIDENCE])
  return candidates
}

/** More parts matched, more confidence; round(min(confidence, cap), 2). */
function score(m: Match, base: number, cap: number): number {
  const g = m.groups!
  let confidence = base
  if (g.gu) confidence += 0.15
  if (g.gu2) confidence += 0.05
  if (g.dong) confidence += 0.15
  if (g.bunji) confidence += 0.2
  if (g.building || g.building_named) confidence += 0.15
  return Math.round(Math.min(confidence, cap) * 100) / 100
}

/**
 * Candidates of every anchor, overlapping ones merged (#465): otherwise an inner candidate
 * pushed out a wider one and its front showed. The merged confidence is the highest.
 */
export function detectAddress(text: string): Detection[] {
  const candidates = candidatesOf(text)
  // Also in a copy with wide gaps collapsed, mapped back (#492); only ever adds.
  if (WIDE_SPACE_RE.search(text)) {
    const [collapsed, toOriginal] = collapseWideSpaces(text)
    for (const [s, e, c] of candidatesOf(collapsed)) candidates.push([toOriginal(s), toOriginal(e - 1) + 1, c])
  }
  candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  const merged: Candidate[] = []
  for (const [s, e, c] of candidates) {
    const last = merged.at(-1)
    if (last !== undefined && s < last[1]) merged[merged.length - 1] = [last[0], Math.max(last[1], e), Math.max(last[2], c)]
    else merged.push([s, e, c])
  }
  return merged.map(([s, e, c]) => ({ kind: 'address', start: s, end: e, text: text.slice(s, e), confidence: c }))
}
