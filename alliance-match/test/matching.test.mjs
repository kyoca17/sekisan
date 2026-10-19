import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, nameSimilarity, parsePower, formatPowerM, formTeams, teamLabel, findDateTime, weekdayFor, buildAnnouncement, teamsToLines, topMember, DEFAULT_TEMPLATE } from '../js/matching.js';

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

test('formTeams: tiered by power, A is the strongest team', () => {
  const members = [
    { name: 'A', power: 38.8e6 }, { name: 'B', power: 11.5e6 }, { name: 'C', power: 11.2e6 }, { name: 'D', power: 11.0e6 },
    { name: 'E', power: 11.0e6 }, { name: 'F', power: 9.9e6 }, { name: 'G', power: 8.8e6 }, { name: 'H', power: 8.7e6 },
    { name: 'I', power: 8.2e6 }, { name: 'J', power: 7.8e6 }, { name: 'K', power: 4.0e6 },
  ];
  // 11人 → 3組(3,4,4)。上から順に区切り、余りは弱い側の組に加える
  const teams = formTeams(members, { size: 3 });
  assert.deepEqual(teams.map((t) => t.label), ['A', 'B', 'C']);
  assert.deepEqual(teams.map((t) => t.members.map((m) => m.name)), [['A', 'B', 'C'], ['D', 'E', 'F', 'G'], ['H', 'I', 'J', 'K']]);
  assert.ok(teams[0].total > teams[1].total && teams[1].total > teams[2].total);
  assert.equal(topMember(teams).name, 'A');
  // 10人 → 3組(3,3,4)
  assert.deepEqual(formTeams(members.slice(0, 10), { size: 3 }).map((t) => t.members.length), [3, 3, 4]);
  // 9人 → 3組(3,3,3)、4人 → 1組(4)、2人 → 1組(2)
  assert.deepEqual(formTeams(members.slice(0, 9)).map((t) => t.members.length), [3, 3, 3]);
  assert.deepEqual(formTeams(members.slice(0, 4)).map((t) => t.members.length), [4]);
  assert.deepEqual(formTeams(members.slice(0, 2)).map((t) => t.members.length), [2]);
  assert.equal(formTeams([]).length, 0);
});

test('teamLabel counts A..Z then AA', () => {
  assert.equal(teamLabel(0), 'A');
  assert.equal(teamLabel(25), 'Z');
  assert.equal(teamLabel(26), 'AA');
  assert.equal(teamLabel(27), 'AB');
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
  assert.ok(msg.startsWith('【クレイジージョイ】チーム発表\n\n次回の開催日時:9/24(木)22:30\n\n【A】A ・ B ・ C\n\n【本部リーダー】A\n\n※事前準備'));
  assert.ok(msg.trimEnd().endsWith('よろしくお願いします！'));
  assert.ok(!msg.includes('30.0M'));
  const custom = buildAnnouncement(teams, { template: '{イベント名}/{日時}/{本部リーダー}\n{組分け}', eventName: 'X', dateTime: 'Y', leader: 'C', showPower: true });
  assert.equal(custom, 'X/Y/C\n【A】A(30.0M) ・ B(10.0M) ・ C(1.0M)　合計 41.0M\n');
  assert.equal(teamsToLines(teams)[0], '【A】A ・ B ・ C');
  assert.ok(DEFAULT_TEMPLATE.includes('{組分け}'));
});

test('resolveName uses aliases, exact and fuzzy matches', async () => {
  const { resolveName, learnName } = await import('../js/matching.js');
  let master = { names: ['むにお', '黒豆禿げ茶', 'ふくにゃんBLv', 'アスカーニャ', 'chucky', 'chucky²'], aliases: {} };
  // 辞書に無く似てもいない → そのまま
  assert.equal(resolveName('TCH', master).how, null);
  // 似ている → 登録名に寄せる
  assert.deepEqual(resolveName('患豆充け茶', master).name, '黒豆禿げ茶');
  assert.equal(resolveName('ふくにやゃんBLv', master).name, 'ふくにゃんBLv');
  assert.equal(resolveName('アスカーニヤ', master).name, 'アスカーニャ');
  // 完全一致(記号・空白の違いは無視)
  assert.equal(resolveName('| chucky |', master).how, 'exact');
  // 辞書に登録すると次から確定
  master = learnName(master, 'TCH', 'むにお');
  assert.equal(resolveName('TCH', master).name, 'むにお');
  assert.equal(resolveName('TCH', master).how, 'alias');
  // 登録名一覧にも追加される
  master = learnName(master, 'Hunterr', 'Hunter');
  assert.ok(master.names.includes('Hunter'));
  assert.equal(resolveName('Hunterr', master).name, 'Hunter');
  // 同じ名前への修正は辞書に入れない
  const before = Object.keys(master.aliases).length;
  master = learnName(master, 'Hunter', 'Hunter');
  assert.equal(Object.keys(master.aliases).length, before);
});

test('formFixedTeams: fixed leaders, one R4 per team, balanced totals', async () => {
  const { formFixedTeams } = await import('../js/matching.js');
  const config = { leaders: [{ label: 'A', name: 'oreo' }, { label: 'B', name: 'error' }, { label: 'C', name: '桜花' }], supports: ['R4a', 'R4b', 'R4c', 'R4d'] };
  const members = [
    { name: 'oreo', power: 12e6 }, { name: 'error', power: 8e6 }, // 桜花 は未参加
    { name: 'R4a', power: 30e6 }, { name: 'R4b', power: 20e6 }, { name: 'R4c', power: 10e6 }, { name: 'R4d', power: 9e6 },
    { name: 'm1', power: 15e6 }, { name: 'm2', power: 14e6 }, { name: 'm3', power: 11e6 }, { name: 'm4', power: 7e6 }, { name: 'm5', power: 6e6 }, { name: 'm6', power: 5e6 }, { name: 'm7', power: 4e6 },
  ];
  const teams = formFixedTeams(members, config);
  assert.deepEqual(teams.map((t) => t.label), ['A', 'B', 'C']);
  // リーダーは必ず先頭。未参加のリーダーは absent
  assert.deepEqual(teams.map((t) => t.members[0].name), ['oreo', 'error', '桜花']);
  assert.equal(teams[2].members[0].absent, true);
  // R4 は各チームに最低1人(4人いるので1チームは2人)
  const supportCounts = teams.map((t) => t.members.filter((m) => m.role === 'support').length).sort();
  assert.deepEqual(supportCounts, [1, 1, 2]);
  // 全員が1回ずつ入る(リーダー3 + 参加12 = 14人: 未参加リーダー1人は名前のみ)
  const all = teams.flatMap((t) => t.members.map((m) => m.name));
  assert.equal(all.length, 14);
  assert.equal(new Set(all).size, 14);
  // 人数は 5,5,4 のように均等
  const sizes = teams.map((t) => t.members.length).sort();
  assert.ok(sizes[2] - sizes[0] <= 1, 'sizes ' + sizes);
  // 合計戦力の差が小さい(最大と最小の差が平均の25%以内)
  const totals = teams.map((t) => t.total);
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  assert.ok(Math.max(...totals) - Math.min(...totals) <= mean * 0.25, 'totals ' + totals.map((t) => (t / 1e6).toFixed(1)));
});

test('formFixedTeams: per-team pinned R4/R5 supports and decorated names', async () => {
  const { formFixedTeams, sameName } = await import('../js/matching.js');
  assert.ok(sameName('桜花 ouka', '桜花'));
  assert.ok(sameName('ｎａｖｉ꒱', 'navi'));
  assert.ok(sameName('アンネ❀·8·❀', 'アンネ'));
  assert.ok(sameName('꧁ERROR꧂', 'ERROR'));
  assert.ok(!sameName('oreo', 'error'));
  const config = {
    leaders: [
      { label: 'A', name: 'oreo', supports: [] },
      { label: 'B', name: 'ERROR', supports: ['navi', 'アンネ'] },
      { label: 'C', name: '桜花 ouka', supports: ['Velika'] },
    ],
    supports: [],
  };
  const members = [
    { name: 'oreo', power: 29.4e6 }, { name: '⊰ERROR⊱', power: 10e6 }, { name: '桜花', power: 12e6 },
    { name: 'Velika', power: 47.6e6 }, { name: 'アンネ❀·8·❀', power: 25.4e6 }, // navi は未参加
    { name: 'm1', power: 20e6 }, { name: 'm2', power: 18e6 }, { name: 'm3', power: 15e6 }, { name: 'm4', power: 9e6 }, { name: 'm5', power: 8e6 }, { name: 'm6', power: 6e6 },
  ];
  const teams = formFixedTeams(members, config);
  const names = (t) => t.members.map((m) => m.name);
  assert.equal(names(teams[0])[0], 'oreo');
  assert.equal(names(teams[1])[0], 'ERROR');
  assert.equal(teams[1].members[0].power, 10e6, 'decorated ERROR matched the leader');
  assert.equal(teams[2].members[0].power, 12e6, '桜花 matched 桜花 ouka');
  // サポートは指定チームに固定。未参加の navi は名前だけ(absent)
  const sup = (t) => t.members.filter((m) => m.role === 'support').map((m) => m.name).sort();
  assert.deepEqual(sup(teams[0]), []);
  assert.deepEqual(sup(teams[1]), ['navi', 'アンネ']);
  assert.deepEqual(sup(teams[2]), ['Velika']);
  assert.equal(teams[1].members.find((m) => m.name === 'navi').absent, true);
  assert.equal(teams[1].members.find((m) => m.name === 'アンネ').power, 25.4e6);
  // 全員1回ずつ(読み取り11人 + 未参加 navi)
  const all = teams.flatMap(names);
  assert.equal(all.length, 12);
  assert.equal(new Set(all).size, 12);
});
