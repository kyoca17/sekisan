import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, nameSimilarity, parsePower, formatPowerM, matchVoterToMaster, matchRankRowToMaster, formTeams, teamsToText } from '../js/matching.js';

const master = [
  { id: '1', name: 'nnnnnnn', power: 38870574 },
  { id: '2', name: 'chucky', power: 10967789 },
  { id: '3', name: '黒豆禿げ茶', power: 11008865 },
  { id: '4', name: 'むにお', power: 11153551 },
  { id: '5', name: 'ふくにゃんBLv', power: 9931308 },
  { id: '6', name: 'un temps libre', power: 8751434 },
  { id: '7', name: 'chucky²', power: 7900143 },
  { id: '8', name: 'てとてと', power: 8272988 },
];

test('normalizeName strips spaces, symbols and width', () => {
  assert.equal(normalizeName(' un temps  libre '), 'untempslibre');
  assert.equal(normalizeName('｜ アス カー ニャ ｜'), 'アスカーニャ');
  assert.equal(normalizeName('シFlower・ＳＤ'), 'シflowersd');
});

test('parsePower handles M/K/B and full numbers', () => {
  assert.equal(parsePower('38.8M'), 38800000);
  assert.equal(parsePower('4.0K'), 4000);
  assert.equal(parsePower('1.2B'), 1200000000);
  assert.equal(parsePower('38,870,574'), 38870574);
  assert.equal(parsePower('8.684215'), 8684215);
  assert.equal(parsePower(''), null);
  assert.equal(formatPowerM(38870574), '38.9M');
});

test('nameSimilarity tolerates OCR noise', () => {
  assert.ok(nameSimilarity('| nnnnnnn |', 'nnnnnnn') > 0.85);
  assert.ok(nameSimilarity('ふく に や ゃ ん BLv', 'ふくにゃんBLv') > 0.8);
  assert.ok(nameSimilarity('chuckv', 'chucky') > 0.8);
  assert.ok(nameSimilarity('Hunter', 'chucky') < 0.5);
});

test('matchVoterToMaster uses name and power', () => {
  assert.equal(matchVoterToMaster({ name: 'nnnnnnn', power: 38800000 }, master).entry.id, '1');
  // 名前がやや化けていても戦力で確定
  assert.equal(matchVoterToMaster({ name: '悪 豆 売 け 茶', power: 11000000 }, master).entry.id, '3');
  // chucky と chucky² は戦力で区別
  assert.equal(matchVoterToMaster({ name: 'chucky', power: 11000000 }, master).entry.id, '2');
  assert.equal(matchVoterToMaster({ name: 'chucky', power: 7900000 }, master).entry.id, '7');
  // 全く知らない人は未照合
  assert.equal(matchVoterToMaster({ name: 'Hunter', power: 7800000 }, master).entry, null);
  // 名前が読めなくても戦力が一意に一致すれば要確認付きで照合
  const weak = matchVoterToMaster({ name: 'TCH', power: 11200000 }, master);
  assert.equal(weak.entry.id, '4');
  assert.equal(weak.weak, true);
  // 同じ戦力表示の人が2人いる(11.0M)場合は名前が読めなければ未照合
  assert.equal(matchVoterToMaster({ name: 'xx', power: 11000000 }, master).entry, null);
});

test('matchRankRowToMaster: same power means same person even if name garbled', () => {
  assert.equal(matchRankRowToMaster({ name: 'oss', power: 11153551 }, master).entry.id, '4');
  assert.equal(matchRankRowToMaster({ name: 'chuckv', power: 10999999 }, master).entry.id, '2');
  assert.equal(matchRankRowToMaster({ name: 'newguy', power: 123 }, master).entry, null);
});

test('formTeams: snake draft puts one top member in each team', () => {
  const members = [
    { name: 'A', power: 38.8e6 }, { name: 'B', power: 11.5e6 }, { name: 'C', power: 11.2e6 }, { name: 'D', power: 11.0e6 },
    { name: 'E', power: 11.0e6 }, { name: 'F', power: 9.9e6 }, { name: 'G', power: 8.8e6 }, { name: 'H', power: 8.7e6 },
    { name: 'I', power: 8.2e6 }, { name: 'J', power: 7.8e6 }, { name: 'K', power: 4.0e6 },
  ];
  const teams = formTeams(members, { size: 3, remainder: 'short' });
  assert.equal(teams.length, 4);
  assert.deepEqual(teams.map((t) => t.members.length).sort(), [2, 3, 3, 3]);
  const leaders = teams.map((t) => t.members[0].name).sort();
  assert.deepEqual(leaders, ['A', 'B', 'C', 'D']);
  assert.equal(new Set(teams.flatMap((t) => t.members.map((m) => m.name))).size, 11);

  const teams2 = formTeams(members, { size: 3, remainder: 'extra' });
  assert.equal(teams2.length, 3);
  assert.deepEqual(teams2.map((t) => t.members.length).sort(), [3, 4, 4]);
  assert.ok(teamsToText(teams2).includes('【1組】'));
});

test('formTeams balances totals when possible', () => {
  const members = [
    { name: 'A', power: 30e6 }, { name: 'B', power: 30e6 }, { name: 'C', power: 10e6 },
    { name: 'D', power: 10e6 }, { name: 'E', power: 1e6 }, { name: 'F', power: 1e6 },
  ];
  const teams = formTeams(members, { size: 3 });
  assert.equal(teams[0].total, teams[1].total);
});
