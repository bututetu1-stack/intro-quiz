// index.html のロジックのテスト（依存なし。node tests/run.js で実行）
//  - <script> の構文チェック
//  - 古い iOS Safari で構文エラーになる正規表現の後読みを使っていないか
//  - 曲名の自動判定（guessSongName）：手作りの例は全問、実際の YouTube タイトルは基準点以上
//    （song-name-vocaloid.tsv はチャンネル名なし。正解が動画タイトルのままの曲を出題時に補正する playableSong 用）
//  - 回答の表記ゆれ吸収（normalize）
//  - 回答の判定（answerMatches）：副題の省略・長い曲名の打ち間違いは正解、短い曲名は厳しく
//  - 4択の選択肢（makeOptions）
//  - 今日のチャレンジの乱数（seededRand）：同じ日付なら同じ並び
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
const VOC_MIN=79;   // 2026-10-21 時点
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

console.log(failed?`\n${failed} 件失敗`:'\nすべて成功');
process.exit(failed?1:0);
