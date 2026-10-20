// index.html のロジックのテスト（依存なし。node tests/run.js で実行）
//  - <script> の構文チェック
//  - 古い iOS Safari で構文エラーになる正規表現の後読みを使っていないか
//  - 曲名の自動判定（guessSongName）：手作りの例は全問、実際の YouTube タイトルは基準点以上
//    （song-name-vocaloid.tsv はチャンネル名なし。正解が動画タイトルのままの曲を出題時に補正する playableSong 用）
//  - 回答の表記ゆれ吸収（normalize）
//  - 回答の判定（answerMatches）：副題の省略・長い曲名の打ち間違いは正解、短い曲名は厳しく
//  - 4択の選択肢（makeOptions）
//  - 今日のチャレンジの乱数（seededRand）：同じ日付なら同じ並び
//  - 対戦の判定（buzzDecideAt・pickBuzzWinner・チーム戦・司会・回答時間）：サーバー時刻を差し替えて確認
const fs=require('fs'), path=require('path'), vm=require('vm'), cp=require('child_process'), os=require('os');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let failed=0;
const ok=(cond,msg)=>{ console.log((cond?'  ok   ':'  FAIL ')+msg); if(!cond) failed++; };

// 1) 構文チェック
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n;\n');
const tmp=path.join(os.tmpdir(),'iq_check_'+process.pid+'.js'); fs.writeFileSync(tmp, scripts);
let syntaxOk=true; try{ cp.execFileSync(process.execPath,['--check',tmp],{stdio:'pipe'}); }catch(e){ syntaxOk=false; console.log(String(e.stderr||e)); }
fs.unlinkSync(tmp);
ok(syntaxOk,'<script> の構文');
ok(!/\(\?<[=!]/.test(scripts),'正規表現の後読みを使っていない（iOS 16.4 未満で動かなくなるため）');

// 2) テスト対象の関数を取り出す（曲名判定ブロックと、normalize・4択の関数）
const pick=(start,end)=>{ const s=scripts.indexOf(start), e=scripts.indexOf(end,s); if(s<0||e<0) throw new Error('見つからない: '+start); return scripts.slice(s,e); };
const fnSrc=(name)=>{ const m=new RegExp('function '+name+'\\([^)]*\\)\\{').exec(scripts); if(!m) throw new Error('関数が見つからない: '+name);
  let i=m.index+m[0].length, depth=1; while(depth>0 && i<scripts.length){ const c=scripts[i++]; if(c==='{') depth++; else if(c==='}') depth--; } return scripts.slice(m.index,i); };
const code=[
  pick('// ===== 曲名の自動判定（YouTubeの動画タイトル','function extractPlaylistId'),
  fnSrc('normalize'), fnSrc('makeOptions'), fnSrc('seededRand'), fnSrc('answerVariants'), fnSrc('editDistance'), fnSrc('answerMatches'), fnSrc('applySearchConsensus'), fnSrc('hintMask'),
  'globalThis.__t={ guessSongName, normalize, makeOptions, seededRand, playableSong, answerMatches, applySearchConsensus, hintMask };'
].join('\n');
const ctx={}; vm.createContext(ctx); vm.runInContext(code, ctx);
const { guessSongName, normalize, makeOptions, seededRand, playableSong, answerMatches, applySearchConsensus, hintMask }=ctx.__t;

// 3) 曲名の自動判定
const readTsv=f=>fs.readFileSync(path.join(__dirname,f),'utf8').split(/\r?\n/).filter(Boolean).map(l=>l.split('\t'));
const run=(rows)=>{ let n=0; const ng=[]; for(const [t,c,exp] of rows){ const r=guessSongName(t,c); if(r.song===exp) n++; else ng.push(`${JSON.stringify(r.song)} ≠ ${JSON.stringify(exp)}  ← ${t}`); } return { n, ng }; };
const basic=readTsv('song-name-basic.tsv'), real=readTsv('song-name-real.tsv');
const b=run(basic), r=run(real);
ok(b.n===basic.length, `曲名判定（手作りの例）${b.n}/${basic.length}`); if(b.n<basic.length) b.ng.forEach(x=>console.log('         '+x));
const REAL_MIN=128;   // 2026-10-21 時点の正解数。下がったら判定ルールの変更を見直す
ok(r.n>=REAL_MIN, `曲名判定（実際のタイトル）${r.n}/${real.length}（基準 ${REAL_MIN} 以上）`);
if(r.n<REAL_MIN || process.argv.includes('-v')) r.ng.forEach(x=>console.log('         '+x));
const voc=readTsv('song-name-vocaloid.tsv'), v=run(voc);
const VOC_MIN=84;   // 2026-10-21 時点
ok(v.n>=VOC_MIN, `曲名判定（ボカロ・チャンネル名なし）${v.n}/${voc.length}（基準 ${VOC_MIN} 以上）`);
if(v.n<VOC_MIN || process.argv.includes('-v')) v.ng.forEach(x=>console.log('         '+x));
const rawSong={ title:'じん / カゲロウデイズ【OFFICIAL MUSIC VIDEO】', answers:['じん / カゲロウデイズ【OFFICIAL MUSIC VIDEO】'] };
const ps=playableSong(rawSong);
ok(ps.answers[0]==='カゲロウデイズ' && !ps.answers.includes(rawSong.title) && rawSong.answers[0]===rawSong.title, '出題時の補正：判定した曲名を正解にする（元データは変えない）');
const handSong={ title:'じん / カゲロウデイズ【OFFICIAL MUSIC VIDEO】', answers:['カゲロウデイズ'] };
ok(playableSong(handSong)===handSong, '出題時の補正：正解を手で入れた曲はそのまま');
const ak=guessSongName('ヒグチアイ / 悪魔の子 (アニメスペシャルVer.) | Ai Higuchi “Akuma no Ko” Anime Special Ver.','ヒグチアイ');
ok(ak.song==='悪魔の子' && ak.alts.includes('Akuma no Ko'), '別解（英語・ローマ字表記）を拾う');

// 4) 表記ゆれ
for(const [a,c] of [['てすと５','テスト5'],['ﾃｽﾄ','テスト'],['ＬＥＭＯＮ','Lemon'],['ゔぁんぷ','ヴァンプ'],['Ｕ.Ｓ.Ａ.','U.S.A.'],['夜に駆ける！','夜に駆ける']])
  ok(normalize(a)===normalize(c), `normalize: 「${a}」＝「${c}」`);
ok(normalize('アイドル')!==normalize('アイロン'), 'normalize: 違う曲名は一致しない');

// 曲名で検索：検索結果の多数決で曲名をそろえる
const sr=[{title:'YOASOBI「夜に駆ける」 Official Music Video',channel:'YOASOBI'},{title:'夜に駆ける',channel:'YOASOBI - Topic'},{title:'YOASOBI 夜に駆ける',channel:'coco mirai'}];
applySearchConsensus(sr);
ok(sr.every(r=>r.song==='夜に駆ける'), '検索結果の多数決：「YOASOBI 夜に駆ける」→「夜に駆ける」');
const sr2=[{title:'YOASOBI「アイドル」 Official Music Video',channel:'YOASOBI'},{title:'YOASOBI「群青」Official Music Video',channel:'YOASOBI'}];
applySearchConsensus(sr2);
ok(sr2[0].song==='アイドル' && sr2[1].song==='群青', '検索結果の多数決：別々の曲はそのまま');

// ソロのヒント
ok(hintMask('夜に駆ける',0)==='○○○○○' && hintMask('夜に駆ける',1)==='夜○○○○', 'ヒント：文字数と1文字目');
ok(hintMask('Bad ∞ End',1)==='B○○ ∞ ○○○', 'ヒント：記号と空白は見せる');

// 5) 回答の判定
for(const [ua, ans, yomi, exp, why] of [
  ['夜に駆ける', ['夜に駆ける'], [], true, '完全一致'],
  ['よるにかける', ['夜に駆ける'], ['よるにかける'], true, 'よみがな'],
  ['lemon', ['Lemon (Remix)'], [], true, '括弧の副題を省略'],
  ['残酷な天使のテーゼ', ['残酷な天使のテーゼ -Director\'s Edit Version-'], [], true, '末尾の -〜- を省略'],
  ['夜に掛ける', ['夜に駆ける'], [], true, '5文字以上は1文字の打ち間違いまで'],
  ['ワールズエンドダンスホル', ['ワールズエンド・ダンスホール'], [], true, '10文字以上は2文字まで'],
  ['アイロン', ['アイドル'], [], false, '4文字以下は打ち間違いを許さない'],
  ['夜に掛けた', ['夜に駆ける'], [], false, '5文字で2文字違いは不正解'],
  ['', ['夜に駆ける'], [], false, '空欄は不正解'],
]) ok(answerMatches(ua, ans, yomi)===exp, `回答の判定：${why}（「${ua}」→ ${exp?'正解':'不正解'}）`);

// 6) 4択
const opts=makeOptions('夜に駆ける',['夜に駆ける','よるにかける','アイドル','群青','怪物','ハルジオン']);
ok(opts.length===4 && opts.includes('夜に駆ける'), '4択：正解を含む4つ');
ok(new Set(opts.map(normalize)).size===4, '4択：同じ表記の選択肢を重ねない');
ok(makeOptions('A',['A']).length===1, '4択：候補が足りなければ少なくなる（画面側で入力欄に切り替える）');

// 7) 今日のチャレンジ
const seq=s=>{ const r=seededRand(s); return Array.from({length:8},()=>r()); };
ok(JSON.stringify(seq('iq-daily:2026-10-21'))===JSON.stringify(seq('iq-daily:2026-10-21')), '今日のチャレンジ：同じ日付なら同じ乱数列（全員同じ曲）');
ok(JSON.stringify(seq('iq-daily:2026-10-21'))!==JSON.stringify(seq('iq-daily:2026-10-22')), '今日のチャレンジ：日付が違えば別の乱数列');
ok(seq('x').every(v=>v>=0 && v<1), '今日のチャレンジ：乱数は 0 以上 1 未満');

// 8) 対戦の判定（Firebase なしで、関数だけを取り出して確認）
const constLine=(name)=>{ const m=new RegExp('const '+name+'=[^;\\n]*;').exec(scripts); if(!m) throw new Error('定数が見つからない: '+name); return m[0]; };
const code2=[
  constLine('BUZZ_MARGIN_MS'), constLine('BUZZ_MAX_WAIT_MS'), constLine('ANSWER_LIMIT_MS'), constLine('TEAMS'),
  'let __now=0; function serverNow(){ return __now; }',
  ...['safeNum','buzzDecideAt','pickBuzzWinner','playerT0','presenterOf','isPresenter','contestants','teamTotals','winningTeam','teamAssignUpdates','answerLimitMs'].map(fnSrc),
  'globalThis.__m={ buzzDecideAt, pickBuzzWinner, playerT0, isPresenter, contestants, teamTotals, winningTeam, teamAssignUpdates, answerLimitMs, setNow:v=>{ __now=v; } };'
].join('\n');
const ctx2={}; vm.createContext(ctx2); vm.runInContext(code2, ctx2);
const M=ctx2.__m;
{ // 早押しの判定時刻：まだ押していない人の再生位置が最短タイムを超えるまで待つ（最大1.5秒）
  const room={ hostUuid:'A', status:'playing', game:{}, players:{ A:{uuid:'A'}, B:{uuid:'B'}, C:{uuid:'C'} } };
  const round={ buzzOpenAt:1000, buzzes:{ A:{ e:7, at:1000 } }, pos:{ A:-6000, B:-5000 } };   // B は1秒遅れて再生、C はまだ再生していない
  M.setNow(1000);
  ok(M.buzzDecideAt(round, room)===2250, '早押しの判定：遅れている人の再生位置が最短タイムを超えるまで待つ（＋0.25秒）');
  room.players.B.listen=true;
  ok(M.buzzDecideAt(round, room)===1250, '早押しの判定：ホストの端末の音で聴く人はホストの再生位置で数える');
  room.players.B.listen=false; round.pos.B=-1000;
  ok(M.buzzDecideAt(round, room)===2500, '早押しの判定：待つのは最初の早押しから最大1.5秒');
  const r2={ buzzOpenAt:1000, buzzes:{ B:{ e:5, at:1000 } }, pos:{ A:0, B:-4000 } };
  const room2={ hostUuid:'A', status:'playing', game:{ presenter:'A' }, players:{ A:{uuid:'A'}, B:{uuid:'B'} } };
  ok(M.buzzDecideAt(r2, room2)===1250, '早押しの判定：司会は待たない');
}
{ // 回答権：再生位置が短い人 → 同じなら先に届いた人。ペナルティ中・部屋にいない人は除く
  M.setNow(2000);
  const round={ buzzes:{ A:{ e:7, at:1000 }, B:{ e:6.5, at:1300 } } };
  ok(M.pickBuzzWinner(round, ['A','B'])[0]==='B', '回答権：後から届いても再生位置が短い人');
  ok(M.pickBuzzWinner({ buzzes:{ A:{ e:6, at:1200 }, B:{ e:6, at:1100 } } }, ['A','B'])[0]==='B', '回答権：同じタイムなら先に届いた人');
  ok(M.pickBuzzWinner({ ...round, lockouts:{ B:5000 } }, ['A','B'])[0]==='A', '回答権：ペナルティ中の人は除く');
  ok(M.pickBuzzWinner(round, ['A'])[0]==='A', '回答権：部屋にいない人は除く');
}
{ // チーム戦・司会
  const room={ hostUuid:'A', status:'playing', game:{ scores:{ A:1, B:3, C:1 } }, players:{ A:{uuid:'A',team:'red'}, B:{uuid:'B',team:'blue'}, C:{uuid:'C',team:'red'} } };
  ok(JSON.stringify(M.teamTotals(room))==='{"red":2,"blue":3}' && M.winningTeam(room)==='blue', 'チーム戦：個人の得点の合計で勝敗');
  room.game.scores.C=2;
  ok(M.winningTeam(room)===null, 'チーム戦：同点は引き分け');
  room.game.presenter='A';
  ok(M.teamTotals(room).red===2 && M.contestants(room).length===2 && M.isPresenter(room,'A'), '司会：得点・人数に数えない');
  const lobby={ id:'R', hostUuid:'A', status:'lobby', players:{ A:{uuid:'A'}, B:{uuid:'B'}, C:{uuid:'C'} } };
  const ups=M.teamAssignUpdates(lobby, 'A'); const vals=Object.values(ups).sort();
  ok(vals.join(',')==='blue,red' && !Object.keys(ups).some(k=>k.includes('/A/')), 'チーム戦：未定の人を人数が少ない方へ振り分け（司会は除く）');
}
ok(M.answerLimitMs({ settings:{ answerLimit:10 } })===10000 && M.answerLimitMs({ settings:{} })===20000 && M.answerLimitMs({ settings:{ answerLimit:999 } })===20000, '回答時間：設定の秒数（未設定・範囲外は20秒）');

console.log(failed?`\n${failed} 件失敗`:'\nすべて成功');
process.exit(failed?1:0);
