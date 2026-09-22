import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, nameSimilarity, parsePower, formatPowerM, formTeams, findDateTime, weekdayFor, buildAnnouncement, teamsToLines, topMember, DEFAULT_TEMPLATE } from '../js/matching.js';

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
  assert.equal(parsePower(''), null);
  assert.equal(formatPowerM(38870574), '38.9M');
});

test('nameSimilarity tolerates OCR noise', () => {
  assert.ok(nameSimilarity('| nnnnnnn |', 'nnnnnnn') > 0.85);
  assert.ok(nameSimilarity('chuckv', 'chucky') > 0.8);
  assert.ok(nameSimilarity('Hunter', 'chucky') < 0.5);
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
  assert.deepEqual(teams.map((t) => t.members[0].name).sort(), ['A', 'B', 'C', 'D']);
  assert.equal(new Set(teams.flatMap((t) => t.members.map((m) => m.name))).size, 11);
  assert.equal(topMember(teams).name, 'A');

  const teams2 = formTeams(members, { size: 3, remainder: 'extra' });
  assert.equal(teams2.length, 3);
  assert.deepEqual(teams2.map((t) => t.members.length).sort(), [3, 4, 4]);
});

test('formTeams balances totals when possible', () => {
  const members = [
    { name: 'A', power: 30e6 }, { name: 'B', power: 30e6 }, { name: 'C', power: 10e6 },
    { name: 'D', power: 10e6 }, { name: 'E', power: 1e6 }, { name: 'F', power: 1e6 },
  ];
  const teams = formTeams(members, { size: 3 });
  assert.equal(teams[0].total, teams[1].total);
});

test('findDateTime parses common Japanese date/time notations', () => {
  const now = new Date(2026, 8, 22); // 2026-09-22
  assert.equal(findDateTime('次回 9/24(木) 22:30 開始', now).text, '9/24(木)22:30');
  assert.equal(findDateTime('9月24日 22:30', now).text, '9/24(木)22:30');   // 曜日は日付から補う
  assert.equal(findDateTime('開催 09/24 22時30分', now).text, '9/24(木)22:30');
  assert.equal(findDateTime('９／２４（木）２２：３０', now).text, '9/24(木)22:30'); // 全角
  assert.equal(findDateTime('戦力 38.8M Lv.28', now), null);
  assert.equal(weekdayFor(1, 1, now), '金'); // 2027-01-01 は金曜
  // 同盟投票画面の表記(月なし)。OCR は文字間に空白を入れる
  assert.equal(findDateTime('【 選 択 】24 日 ( 木 )22:30 か ら\nジョ イ 参 加 確 認', now).text, '9/24(木)22:30');
  // 今日より前の日は翌月以降。曜日が合う月を優先(2026-10-24 は土曜、11/24 は火曜、12/24 は木曜)
  assert.equal(findDateTime('24日(木)22:30', new Date(2026, 8, 25)).text, '12/24(木)22:30');
  // 曜日が無ければ次に来るその日
  assert.equal(findDateTime('1日 20:00', new Date(2026, 8, 25)).text, '10/1(木)20:00');
  // 「日」「木」がラテン文字に化けた場合も日付は拾い、曜日は日付から補う
  assert.equal(findDateTime('[EIR] 24H(K)22:30H 5', now).text, '9/24(木)22:30');
  // 「22時までに」のような時刻だけの文には反応しない
  assert.equal(findDateTime('援軍送り合いは22時までに完了させて下さい', now), null);
});

test('buildAnnouncement fills the template', () => {
  const teams = formTeams([{ name: 'A', power: 30e6 }, { name: 'B', power: 10e6 }, { name: 'C', power: 1e6 }], { size: 3 });
  const msg = buildAnnouncement(teams, { dateTime: '9/24(木)22:30' });
  assert.ok(msg.startsWith('【クレイジージョイ】チーム発表\nみなさん、投票ありがとうございました！\n次回の開催は9/24(木)22:30からです。'));
  assert.ok(msg.includes('【1組】A ・ B ・ C'));
  assert.ok(msg.includes('◾️本部リーダー　A'));
  assert.ok(msg.trimEnd().endsWith('よろしくお願いします！'));
  assert.ok(!msg.includes('30.0M'));
  const custom = buildAnnouncement(teams, { template: '{イベント名}/{日時}/{本部リーダー}\n{組分け}', eventName: 'X', dateTime: 'Y', leader: 'C', showPower: true });
  assert.equal(custom, 'X/Y/C\n【1組】A(30.0M) ・ B(10.0M) ・ C(1.0M)　合計 41.0M\n');
  assert.equal(teamsToLines(teams)[0], '【1組】A ・ B ・ C');
  assert.ok(DEFAULT_TEMPLATE.includes('{組分け}'));
});
